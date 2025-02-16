import * as vscode from 'vscode';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface LyricLine {
    text: string;
    time: number; // time in milliseconds
}

interface CurrentTrack {
    app: string;  // Add app to interface
    artist: string;
    title: string;
    position: number;
    duration: number; // Add duration field
    isPlaying: boolean;
}

interface LrcLibSearchResult {
    id: number;
    name: string;
    trackName: string;
    artistName: string;
    albumName: string;
    duration: number;
    instrumentalFlag: boolean;
    syncedFlag: boolean;
}

interface LrcLibLyrics {
    id: number;
    name: string;
    trackName: string;
    artistName: string;
    albumName: string;
    duration: number;
    instrumentalFlag: boolean;
    syncedFlag: boolean;
    plainLyrics: string;
    syncedLyrics: Array<{
        time: number;  // milliseconds
        text: string;
    }>;
}

interface CachedLyrics {
    syncedLyrics: LyricLine[];
    plainLyrics: string;
    timestamp: number;
}

let statusBarItem: vscode.StatusBarItem;
let currentPanel: vscode.WebviewPanel | undefined = undefined;
let currentTrack: CurrentTrack | null = null;
let fullLyrics: string = '';

// Global state to track last error time and type
let lastErrorTime = 0;
let lastErrorType = '';
const ERROR_COOLDOWN_MS = 30000; // Increase cooldown to 30 seconds

// Simple function to update status bar text
function updateStatusBarText(text: string) {
    // Add space before emoji and reduce padding at the end
    statusBarItem.text = ` 🎵  ${text}   `;
}

// Add a debounce to prevent too frequent updates
function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout | null = null;
    return (...args: Parameters<T>) => {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => {
            timeout = null;
            func(...args);
        }, wait);
    };
}

export function activate(context: vscode.ExtensionContext) {
    // Create status bar item with highest priority (closest to the right)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    statusBarItem.name = "Now Playing Lyrics";
    statusBarItem.command = 'nowPlayingLyrics.showPanel';
    updateStatusBarText('Waiting for music...');
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    let currentLyrics: LyricLine[] = [];
    let lastTrackId: string = '';
    const lyricsCache = new Map<string, CachedLyrics>();

    // Function to clear current lyrics state
    function clearLyricsState() {
        currentLyrics = [];
        fullLyrics = '';
        updateStatusBarText('Waiting for music...');
        statusBarItem.tooltip = 'No music playing';
        updatePanel();
    }

    // Register command to show lyrics panel
    let disposable = vscode.commands.registerCommand('nowPlayingLyrics.showPanel', () => {
        if (currentPanel) {
            currentPanel.reveal(vscode.ViewColumn.Beside);
        } else {
            currentPanel = vscode.window.createWebviewPanel(
                'lyricsPanel',
                'Now Playing Lyrics',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            // Add icon to the panel title
            currentPanel.iconPath = {
                light: vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(`
                    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                        <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm3.5 11.5l-5 3a.5.5 0 0 1-.75-.4v-6a.5.5 0 0 1 .75-.4l5 3a.5.5 0 0 1 0 .8z"/>
                    </svg>
                `).toString('base64')),
                dark: vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(`
                    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                        <path fill="#C5C5C5" d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm3.5 11.5l-5 3a.5.5 0 0 1-.75-.4v-6a.5.5 0 0 1 .75-.4l5 3a.5.5 0 0 1 0 .8z"/>
                    </svg>
                `).toString('base64'))
            };

            updatePanel();

            // Handle panel disposal
            currentPanel.onDidDispose(() => {
                currentPanel = undefined;
            }, null, context.subscriptions);
        }
    });

    context.subscriptions.push(disposable);

    // Register command for showing permission help
    context.subscriptions.push(vscode.commands.registerCommand('nowPlayingLyrics.showPermissionHelp', () => {
        vscode.window.showInformationMessage(
            'To grant permissions:\n\n' +
            '1. Open System Settings → Privacy & Security → Automation\n' +
            '2. Find and enable permissions for:\n' +
            `   - ${vscode.env.appName}\n` +
            '   - Music\n' +
            '   - Spotify (if you use it)\n' +
            `3. Restart ${vscode.env.appName}`,
            { modal: true }
        );
    }));

    // Debounce the update to run at most once every 500ms
    const debouncedUpdate = debounce(async () => {
        try {
            console.log('Checking for current track...');
            const track = await getCurrentTrack();
            
            if (!track) {
                console.log('No track returned');
                if (currentTrack !== null) {
                    clearLyricsState();
                    currentTrack = null;
                }
                return;
            }

            console.log('Current track:', track);
            currentTrack = track;

            if (!track.isPlaying) {
                console.log('Track is paused');
                updateStatusBarText('Paused   ');
                statusBarItem.command = 'nowPlayingLyrics.showPanel';
                return;
            }

            // Check if song has changed
            const trackId = `${track.artist}-${track.title}`;
            console.log('Track ID:', trackId, 'Last Track ID:', lastTrackId);
            
            if (trackId !== lastTrackId) {
                console.log('Song changed, fetching new lyrics');
                lastTrackId = trackId;
                currentLyrics = [];
                updateStatusBarText('Fetching lyrics...   ');

                try {
                    // Check cache first
                    const cached = lyricsCache.get(trackId);
                    if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
                        console.log('Using cached lyrics');
                        currentLyrics = cached.syncedLyrics;
                        fullLyrics = cached.plainLyrics;
                        statusBarItem.tooltip = `Now Playing: ${track.title} - ${track.artist}\n\nClick to view full lyrics`;
                        statusBarItem.command = 'nowPlayingLyrics.showPanel';
                        updatePanel();
                        return;
                    }

                    console.log('Fetching fresh lyrics');
                    const lyricsResult = await fetchSynchronizedLyrics(track.artist, track.title);
                    
                    // Cache the result
                    lyricsCache.set(trackId, {
                        syncedLyrics: lyricsResult.syncedLyrics,
                        plainLyrics: lyricsResult.plainLyrics,
                        timestamp: Date.now()
                    });

                    // Only update lyrics if the song hasn't changed while fetching
                    if (lastTrackId === trackId) {
                        console.log('Updating lyrics');
                        currentLyrics = lyricsResult.syncedLyrics;
                        fullLyrics = cleanLyrics(lyricsResult.plainLyrics);
                        statusBarItem.tooltip = `Now Playing: ${track.title} - ${track.artist}\n\nClick to view full lyrics`;
                        statusBarItem.command = 'nowPlayingLyrics.showPanel';
                        updatePanel();
                    } else {
                        console.log('Song changed while fetching lyrics');
                    }
                } catch (error) {
                    console.error('Error fetching lyrics for new song:', error);
                    updateStatusBarText('No lyrics found   ');
                    statusBarItem.tooltip = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
                    currentLyrics = [];
                    fullLyrics = '';
                    updatePanel();
                }
            }

            // Find and display current lyric line
            const currentLine = findCurrentLyricLine(currentLyrics, track.position * 1000);
            if (currentLine) {
                updateStatusBarText(currentLine.text);
                statusBarItem.command = 'nowPlayingLyrics.showPanel';
            } else if (currentLyrics.length > 0) {
                updateStatusBarText('...   ');
                statusBarItem.command = 'nowPlayingLyrics.showPanel';
            }

        } catch (error) {
            console.error('Error in update interval:', error);
            if (error instanceof Error && (
                error.message.includes('not allowed') || 
                error.message.includes('permission') || 
                error.message.includes('authorized') ||
                error.message.includes('timed out')
            )) {
                updateStatusBarText('⚠️ Permission needed   ');
                statusBarItem.command = 'nowPlayingLyrics.showPermissionHelp';
            } else {
                console.error('Unexpected error:', error);
            }
            if (currentTrack !== null) {
                clearLyricsState();
                currentTrack = null;
            }
        }
    }, 500);

    let updateInterval: NodeJS.Timeout | null = null;

    const startUpdateInterval = () => {
        if (updateInterval) {
            clearInterval(updateInterval);
        }
        debouncedUpdate();
        updateInterval = setInterval(debouncedUpdate, 1000);
    };

    // Check if we've shown the welcome message before
    const hasShownWelcome = context.globalState.get('hasShownWelcome', false);

    if (!hasShownWelcome) {
        const message = 'Now Playing Lyrics needs access to your music apps';
        const detail = `To show lyrics for your music, this extension needs to:

1. Check which music app is playing (Music or Spotify)
2. Get the current song info

Click Allow when macOS asks for permission. You can manage these anytime in System Settings → Privacy & Security → Automation.`;

        vscode.window.showInformationMessage(message, { modal: true, detail }, 'Get Started')
            .then(async selection => {
                if (selection === 'Get Started') {
                    await context.globalState.update('hasShownWelcome', true);
                    startUpdateInterval();
                }
            });

        // Show initial status
        statusBarItem.text = "$(info) Click to setup Now Playing Lyrics";
        statusBarItem.command = 'nowPlayingLyrics.showPermissionHelp';
        statusBarItem.show();
    } else {
        startUpdateInterval();
    }

    // Register the permission help command
    context.subscriptions.push(vscode.commands.registerCommand('nowPlayingLyrics.showPermissionHelp', async () => {
        const message = 'Now Playing Lyrics needs permission to access your music apps.';
        const detail = `To grant permissions:

1. Open System Settings
2. Go to Privacy & Security → Automation
3. Find "Visual Studio Code" (or your editor)
4. Enable permissions for:
   - System Events
   - Music
   - Spotify (if you use it)

Would you like to open System Settings now?`;

        const selection = await vscode.window.showInformationMessage(message, { modal: true, detail }, 'Open Settings', 'Learn More');
        if (selection === 'Open Settings') {
            // Open System Settings to the Privacy & Security page
            await vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'));
        } else if (selection === 'Learn More') {
            await vscode.env.openExternal(vscode.Uri.parse('https://github.com/maniyadv/vscode-now-playing-lyrics#permissions'));
        }
    }));

    context.subscriptions.push(
        { dispose: () => { if (updateInterval) clearInterval(updateInterval); } }
    );
}

async function getCurrentTrack(): Promise<CurrentTrack | null> {
    const script = `
        on run
            set musicIsRunning to false
            set spotifyIsRunning to false
            
            try
                tell application "System Events"
                    log "Checking running apps..."
                    set musicIsRunning to exists (processes where name is "Music")
                    set spotifyIsRunning to exists (processes where name is "Spotify")
                    log "Music running: " & musicIsRunning
                    log "Spotify running: " & spotifyIsRunning
                end tell
                
                if spotifyIsRunning then
                    try
                        tell application "Spotify"
                            log "Getting Spotify state..."
                            if it is running then
                                try
                                    set playerState to player state
                                    log "Spotify player state: " & playerState
                                    if playerState is playing or playerState is paused then
                                        set currentTrack to current track
                                        log "Got Spotify track info"
                                        return "spotify:" & artist of current track & "," & name of current track & "," & player position & "," & duration of current track & "," & (playerState is playing)
                                    end if
                                on error errMsg
                                    log "Error getting Spotify track: " & errMsg
                                    error errMsg
                                end try
                            end if
                        end tell
                    on error errMsg
                        log "Error in Spotify block: " & errMsg
                        error errMsg
                    end try
                end if
                
                if musicIsRunning then
                    try
                        tell application "Music"
                            log "Getting Music state..."
                            if it is running then
                                try
                                    set playerState to player state
                                    log "Music player state: " & playerState
                                    if playerState is playing or playerState is paused then
                                        set currentTrack to current track
                                        log "Got Music track info"
                                        return "music:" & artist of currentTrack & "," & name of currentTrack & "," & player position & "," & duration of current track & "," & (playerState is playing)
                                    end if
                                on error errMsg
                                    log "Error getting Music track: " & errMsg
                                    error errMsg
                                end try
                            end if
                        end tell
                    on error errMsg
                        log "Error in Music block: " & errMsg
                        error errMsg
                    end try
                end if
                
                return "none:No track playing"
            on error errMsg
                log "Top level error: " & errMsg
                error errMsg
            end try
        end run
    `;

    try {
        console.log('Executing AppleScript...');
        const { stdout, stderr } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
        console.log('AppleScript stdout:', stdout);
        if (stderr) {
            console.error('AppleScript stderr:', stderr);
        }

        if (!stdout.trim()) {
            console.log('No output from AppleScript');
            return null;
        }

        const [app, ...parts] = stdout.trim().split(':');
        const info = parts.join(':');

        if (app === 'none') {
            console.log('No track playing');
            return null;
        }

        if (app === 'error') {
            console.error('Error from AppleScript:', info);
            throw new Error(info);
        }

        const [artist, title, position, duration, isPlaying] = info.split(',');
        return {
            app,
            artist,
            title,
            position: parseFloat(position),
            duration: parseFloat(duration),
            isPlaying: isPlaying === 'true'
        };
    } catch (error: any) {
        console.error('Error executing AppleScript:', error);
        if (error.stderr) {
            console.error('AppleScript stderr:', error.stderr);
        }
        throw error;
    }
}

async function fetchSynchronizedLyrics(artist: string, title: string): Promise<{ syncedLyrics: LyricLine[]; plainLyrics: string }> {
    const sources = [
        fetchFromLrcLib,
        fetchFromNetease,
        fetchFromQQMusic
    ];

    let lastError: Error | null = null;

    // Try each source in sequence
    for (const source of sources) {
        try {
            const result = await source(artist, title);
            if (result.syncedLyrics.length > 0) {
                return result;
            }
        } catch (error) {
            console.error(`Error fetching from source:`, error);
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }

    throw lastError || new Error('No lyrics found in any source');
}

async function fetchFromLrcLib(artist: string, title: string): Promise<{ syncedLyrics: LyricLine[]; plainLyrics: string }> {
    console.log(`Searching lrclib for: ${title} - ${artist}`);
    
    const searchResponse = await axios.get('https://lrclib.net/api/search', {
        params: {
            track_name: title,
            artist_name: artist
        }
    });

    const searchResults = searchResponse.data as LrcLibSearchResult[];
    if (!searchResults || searchResults.length === 0) {
        throw new Error(`No lyrics found on lrclib for ${title} - ${artist}`);
    }

    // Sort and try each result
    const sortedResults = sortSearchResults(searchResults, artist, title);
    
    for (const result of sortedResults) {
        try {
            const lyricsResponse = await axios.get(`https://lrclib.net/api/get/${result.id}`);
            const lyricsData = lyricsResponse.data as LrcLibLyrics;

            if (lyricsData.syncedLyrics?.length > 0) {
                return {
                    syncedLyrics: lyricsData.syncedLyrics.map(line => ({
                        text: line.text.trim(),
                        time: line.time
                    })).filter(line => line.text),
                    plainLyrics: lyricsData.plainLyrics || lyricsData.syncedLyrics.map(l => l.text).join('\n')
                };
            }
        } catch (error) {
            console.error('Error fetching specific lyrics:', error);
            continue;
        }
    }
    
    throw new Error('No synchronized lyrics found on lrclib');
}

async function fetchFromNetease(artist: string, title: string): Promise<{ syncedLyrics: LyricLine[]; plainLyrics: string }> {
    console.log(`Searching Netease for: ${title} - ${artist}`);
    
    try {
        // First search for the song
        const searchResponse = await axios.get('https://netease-cloud-music-api-psi-silk.vercel.app/search', {
            params: {
                keywords: `${artist} ${title}`,
                type: 1 // 1 for songs
            }
        });

        if (!searchResponse.data?.result?.songs?.[0]) {
            throw new Error('Song not found on Netease');
        }

        const songId = searchResponse.data.result.songs[0].id;
        
        // Then fetch lyrics
        const lyricsResponse = await axios.get(`https://netease-cloud-music-api-psi-silk.vercel.app/lyric?id=${songId}`);
        
        if (!lyricsResponse.data?.lrc?.lyric) {
            throw new Error('No lyrics found on Netease');
        }

        // Parse LRC format
        const lines = lyricsResponse.data.lrc.lyric
            .split('\n')
            .map((line: string) => {
                const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
                if (match) {
                    const minutes = parseInt(match[1]);
                    const seconds = parseFloat(match[2]);
                    const text = match[3].trim();
                    return {
                        text,
                        time: (minutes * 60 + seconds) * 1000
                    };
                }
                return null;
            })
            .filter((line: LyricLine | null): line is LyricLine => line !== null && line.text !== '');

        return {
            syncedLyrics: lines,
            plainLyrics: lines.map((l: LyricLine) => l.text).join('\n')
        };
    } catch (error) {
        console.error('Error fetching from Netease:', error);
        throw error;
    }
}

async function fetchFromQQMusic(artist: string, title: string): Promise<{ syncedLyrics: LyricLine[]; plainLyrics: string }> {
    console.log(`Searching QQ Music for: ${title} - ${artist}`);
    
    try {
        // First search for the song
        const searchResponse = await axios.get('https://c.y.qq.com/soso/fcgi-bin/client_search_cp', {
            params: {
                w: `${artist} ${title}`,
                format: 'json',
                p: 1,
                n: 1
            }
        });

        if (!searchResponse.data?.data?.song?.list?.[0]) {
            throw new Error('Song not found on QQ Music');
        }

        const song = searchResponse.data.data.song.list[0];
        const songmid = song.songmid;
        
        // Then fetch lyrics
        const lyricsResponse = await axios.get(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg`, {
            params: {
                songmid: songmid,
                format: 'json',
                nobase64: 1
            },
            headers: {
                Referer: 'https://y.qq.com'
            }
        });
        
        if (!lyricsResponse.data?.lyric) {
            throw new Error('No lyrics found on QQ Music');
        }

        // Parse LRC format
        const lines = lyricsResponse.data.lyric
            .split('\n')
            .map((line: string) => {
                const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
                if (match) {
                    const minutes = parseInt(match[1]);
                    const seconds = parseFloat(match[2]);
                    const text = match[3].trim();
                    return {
                        text,
                        time: (minutes * 60 + seconds) * 1000
                    };
                }
                return null;
            })
            .filter((line: LyricLine | null): line is LyricLine => line !== null && line.text !== '');

        return {
            syncedLyrics: lines,
            plainLyrics: lines.map((l: LyricLine) => l.text).join('\n')
        };
    } catch (error) {
        console.error('Error fetching from QQ Music:', error);
        throw error;
    }
}

function sortSearchResults(results: LrcLibSearchResult[], targetArtist: string, targetTitle: string): LrcLibSearchResult[] {
    return results.sort((a, b) => {
        // Prefer synced lyrics
        if (a.syncedFlag && !b.syncedFlag) return -1;
        if (!a.syncedFlag && b.syncedFlag) return 1;

        // Prefer exact artist matches
        const aArtistMatch = a.artistName.toLowerCase() === targetArtist.toLowerCase();
        const bArtistMatch = b.artistName.toLowerCase() === targetArtist.toLowerCase();
        if (aArtistMatch && !bArtistMatch) return -1;
        if (!aArtistMatch && bArtistMatch) return 1;

        // Prefer exact title matches
        const aTitleMatch = a.trackName.toLowerCase() === targetTitle.toLowerCase();
        const bTitleMatch = b.trackName.toLowerCase() === targetTitle.toLowerCase();
        if (aTitleMatch && !bTitleMatch) return -1;
        if (!aTitleMatch && bTitleMatch) return 1;

        return 0;
    });
}

function findCurrentLyricLine(lyrics: LyricLine[], currentTimeMs: number): LyricLine | null {
    return lyrics.find((line, index) => {
        const nextLine = lyrics[index + 1];
        return line.time <= currentTimeMs && (!nextLine || nextLine.time > currentTimeMs);
    }) || null;
}

function cleanLyrics(text: string): string {
    // Remove credits and metadata lines
    const lines = text.split('\n');
    const cleanedLines = lines.filter(line => {
        const lowercaseLine = line.toLowerCase();
        return !lowercaseLine.includes('作词') &&
               !lowercaseLine.includes('作曲') &&
               !lowercaseLine.includes('编曲') &&
               !lowercaseLine.includes('producer') &&
               !lowercaseLine.includes('composer') &&
               !lowercaseLine.includes('lyricist');
    });
    return cleanedLines.join('\n');
}

function getWebviewContent(title: string, artist: string, lyrics: string): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Now Playing Lyrics</title>
        <style>
            body {
                padding: 20px;
                line-height: 1.6;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
            }
            .song-info {
                margin-bottom: 20px;
                padding-bottom: 20px;
                border-bottom: 1px solid var(--vscode-panel-border);
            }
            .title {
                font-size: 1.5em;
                font-weight: bold;
                color: var(--vscode-editor-foreground);
            }
            .artist {
                font-size: 1.2em;
                color: var(--vscode-descriptionForeground);
            }
            .lyrics {
                white-space: pre-wrap;
                color: var(--vscode-editor-foreground);
            }
            .current-line {
                background-color: var(--vscode-editor-selectionBackground);
                padding: 2px 5px;
                border-radius: 3px;
            }
        </style>
    </head>
    <body>
        <div class="song-info">
            <div class="title">${title}</div>
            <div class="artist">${artist}</div>
        </div>
        <div class="lyrics">${lyrics}</div>
    </body>
    </html>`;
}

// Update panel content when lyrics change
function updatePanel() {
    if (currentPanel) {
        currentPanel.webview.html = getWebviewContent(
            currentTrack?.title || '',
            currentTrack?.artist || '',
            fullLyrics || ''
        );
    }
}

export function deactivate() {}
