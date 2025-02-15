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

// Simple function to update status bar text
function updateStatusBarText(text: string) {
    // Add space before emoji and extra padding at the end to center align text
    statusBarItem.text = ` 🎵  ${text}        `;
}

// Function to show error message with cooldown
function showErrorWithCooldown(message: string) {
    const now = Date.now();
    if (now - (showErrorWithCooldown as any).lastErrorTime > (showErrorWithCooldown as any).ERROR_COOLDOWN) {
        vscode.window.showErrorMessage(message);
        (showErrorWithCooldown as any).lastErrorTime = now;
    }
}
(showErrorWithCooldown as any).lastErrorTime = 0;
(showErrorWithCooldown as any).ERROR_COOLDOWN = 5000; // 5 seconds cooldown between error messages

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

    // Update interval
    const updateInterval = setInterval(async () => {
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
                updateStatusBarText('Paused');
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
                updateStatusBarText('Fetching lyrics...');

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
                    updateStatusBarText('No lyrics found');
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
                updateStatusBarText('...');
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
                console.log('Permission error, showing help');
                updateStatusBarText('⚠️ Permission needed');
                statusBarItem.command = 'nowPlayingLyrics.showPermissionHelp';
                showErrorWithCooldown('Now Playing Lyrics needs permission to access Music/Spotify. Please check Privacy & Security settings.');
            } else {
                console.error('Unexpected error:', error);
            }
            if (currentTrack !== null) {
                clearLyricsState();
                currentTrack = null;
            }
        }
    }, 100);

    context.subscriptions.push(
        { dispose: () => clearInterval(updateInterval) }
    );
}

async function getCurrentTrack(): Promise<CurrentTrack | null> {
    const script = `
        on run
            set musicIsRunning to false
            set spotifyIsRunning to false
            
            try
                tell application "System Events"
                    set musicIsRunning to exists (processes where name is "Music")
                    set spotifyIsRunning to exists (processes where name is "Spotify")
                end tell
                
                if spotifyIsRunning then
                    try
                        tell application "Spotify"
                            if it is running then
                                try
                                    set playerState to player state
                                    if playerState is playing or playerState is paused then
                                        set currentTrack to current track
                                        return "spotify:" & artist of current track & "," & name of current track & "," & player position & "," & duration of current track & "," & (playerState is playing)
                                    end if
                                on error errMsg
                                    -- This error occurs when Spotify is not authorized
                                    if errMsg contains "not allowed" or errMsg contains "permission" or errMsg contains "authorized" then
                                        error "Spotify needs to be authorized in System Settings → Privacy & Security → Automation"
                                    end if
                                    error errMsg
                                end try
                            end if
                        end tell
                    on error errMsg
                        return "error:Spotify: " & errMsg
                    end try
                end if
                
                if musicIsRunning then
                    try
                        tell application "Music"
                            if it is running then
                                try
                                    set playerState to player state
                                    if playerState is playing or playerState is paused then
                                        set currentTrack to current track
                                        return "music:" & artist of currentTrack & "," & name of currentTrack & "," & player position & "," & duration of current track & "," & (playerState is playing)
                                    end if
                                on error errMsg
                                    -- This error occurs when Music is not authorized
                                    if errMsg contains "not allowed" or errMsg contains "permission" or errMsg contains "authorized" then
                                        error "Music needs to be authorized in System Settings → Privacy & Security → Automation"
                                    end if
                                    error errMsg
                                end try
                            end if
                        end tell
                    on error errMsg
                        return "error:Music: " & errMsg
                    end try
                end if
                
                return "none:No track playing"
            on error errMsg
                if errMsg contains "not allowed" or errMsg contains "permission" or errMsg contains "authorized" then
                    return "error:Permission denied. Please check Privacy & Security settings."
                else
                    return "error:" & errMsg
                end if
            end try
        end run
    `;

    try {
        console.log('Executing AppleScript...');
        
        // Create a promise that rejects after 5 seconds
        const timeoutPromise = new Promise<{stdout: string, stderr: string}>((_, reject) => {
            setTimeout(() => reject(new Error('AppleScript timed out. Please check Privacy & Security settings.')), 5000);
        });

        // Race between the actual command and the timeout
        const { stdout, stderr } = await Promise.race([
            execAsync(`osascript -e '${script}'`) as Promise<{stdout: string, stderr: string}>,
            timeoutPromise
        ]);

        if (stderr) {
            console.error('AppleScript stderr:', stderr);
            if (stderr.includes('not allowed') || stderr.includes('permission') || stderr.includes('authorized')) {
                updateStatusBarText('⚠️ Permission needed');
                showErrorWithCooldown('Now Playing Lyrics needs permission to access Music/Spotify. Please check Privacy & Security settings.');
                throw new Error('Permission denied');
            }
        }

        console.log('Raw player output:', stdout);
        console.log('Trimmed output:', stdout.trim());

        if (!stdout.trim() || stdout.trim() === 'none:No track playing') {
            console.log('No track detected, throwing error');
            throw new Error('No track currently playing');
        }

        const [source, ...parts] = stdout.trim().split(':');
        console.log('Source:', source);
        console.log('Parts:', parts);

        if (source === 'error') {
            const errorMsg = parts.join(':');
            if (errorMsg.includes('not allowed') || errorMsg.includes('permission') || errorMsg.includes('authorized')) {
                updateStatusBarText('⚠️ Permission needed');
                showErrorWithCooldown('Now Playing Lyrics needs permission to access Music/Spotify. Please check Privacy & Security settings.');
            }
            throw new Error(errorMsg);
        }

        const [artist, title, position, duration, isPlaying] = parts.join(':').split(',');
        console.log('Parsed values:', { artist, title, position, duration, isPlaying });

        const cleanArtist = artist.replace(/[^\w\s-]/g, ' ').trim();
        const cleanTitle = title.replace(/[^\w\s-]/g, ' ').trim();
        console.log('Cleaned values:', { cleanArtist, cleanTitle });

        if (!cleanArtist && cleanTitle.includes('-')) {
            const [possibleArtist, ...titleParts] = cleanTitle.split('-').map((part: string) => part.trim());
            return {
                artist: possibleArtist,
                title: titleParts.join('-'),
                position: parseFloat(position) || 0,
                duration: parseFloat(duration) || 0,
                isPlaying: isPlaying === 'true'
            };
        }

        return {
            artist: cleanArtist,
            title: cleanTitle,
            position: parseFloat(position) || 0,
            duration: parseFloat(duration) || 0,
            isPlaying: isPlaying === 'true'
        };
    } catch (error) {
        console.error('Error getting current track:', error);
        if (error instanceof Error && (
            error.message.includes('not allowed') || 
            error.message.includes('permission') || 
            error.message.includes('authorized') ||
            error.message.includes('timed out')
        )) {
            updateStatusBarText('⚠️ Permission needed');
            showErrorWithCooldown('Now Playing Lyrics needs permission to access Music/Spotify. Please check Privacy & Security settings.');
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
