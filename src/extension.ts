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

    // Function to clear current lyrics state
    function clearLyricsState() {
        currentLyrics = [];
        fullLyrics = '';
        updateStatusBarText('Waiting for music...');
        statusBarItem.tooltip = 'No music playing';
        updatePanel();
    }

    // Update interval
    const updateInterval = setInterval(async () => {
        try {
            const track = await getCurrentTrack();
            
            if (!track) {
                if (currentTrack !== null) {
                    clearLyricsState();
                    currentTrack = null;
                }
                return;
            }

            currentTrack = track;

            if (!track.isPlaying) {
                updateStatusBarText('Paused');
                return;
            }

            // Check if song has changed
            const trackId = `${track.artist}-${track.title}`;
            if (trackId !== lastTrackId) {
                lastTrackId = trackId;
                currentLyrics = [];
                updateStatusBarText('Fetching lyrics...');

                try {
                    // Check cache first
                    const cached = lyricsCache.get(trackId);
                    if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
                        currentLyrics = cached.syncedLyrics;
                        fullLyrics = cached.plainLyrics;
                        statusBarItem.tooltip = `Now Playing: ${track.title} - ${track.artist}\n\nClick to view full lyrics`;
                        updatePanel();
                        return;
                    }

                    const lyricsResult = await fetchSynchronizedLyrics(track.artist, track.title);
                    
                    // Cache the result
                    lyricsCache.set(trackId, {
                        syncedLyrics: lyricsResult.syncedLyrics,
                        plainLyrics: lyricsResult.plainLyrics,
                        timestamp: Date.now()
                    });

                    // Only update lyrics if the song hasn't changed while fetching
                    if (lastTrackId === trackId) {
                        currentLyrics = lyricsResult.syncedLyrics;
                        fullLyrics = cleanLyrics(lyricsResult.plainLyrics);
                        statusBarItem.tooltip = `Now Playing: ${track.title} - ${track.artist}\n\nClick to view full lyrics`;
                        updatePanel();
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
            } else if (currentLyrics.length > 0) {
                updateStatusBarText('...');
            }

        } catch (error) {
            console.error('Error in update interval:', error);
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
            
            tell application "System Events"
                set musicIsRunning to exists (processes where name is "Music")
                set spotifyIsRunning to exists (processes where name is "Spotify")
            end tell
            
            if musicIsRunning then
                tell application "Music"
                    set playerState to player state
                    if playerState is playing or playerState is paused then
                        set currentTrack to current track
                        return "music:" & artist of currentTrack & "," & name of currentTrack & "," & player position & "," & duration of current track & "," & (playerState is playing)
                    end if
                end tell
            end if
            
            if spotifyIsRunning then
                tell application "Spotify"
                    set playerState to player state
                    if playerState is playing or playerState is paused then
                        set currentTrack to current track
                        return "spotify:" & artist of current track & "," & name of current track & "," & player position & "," & duration of current track & "," & (playerState is playing)
                    end if
                end tell
            end if
            
            return "none:No track playing"
        end run
    `;

    try {
        const { stdout, stderr } = await execAsync(`osascript -e '${script}'`);
        if (stderr) {
            console.error('AppleScript stderr:', stderr);
        }

        console.log('Raw player output:', stdout);

        if (!stdout.trim() || stdout.trim() === 'none:No track playing') {
            throw new Error('No track currently playing');
        }

        const [source, ...parts] = stdout.trim().split(':');
        const [artist, title, position, duration, isPlaying] = parts.join(':').split(',');

        const cleanArtist = artist.replace(/[^\w\s-]/g, ' ').trim();
        const cleanTitle = title.replace(/[^\w\s-]/g, ' ').trim();

        if (!cleanArtist && cleanTitle.includes('-')) {
            const [possibleArtist, ...titleParts] = cleanTitle.split('-').map(part => part.trim());
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
        throw new Error(error instanceof Error ? error.message : 'Failed to get current track');
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
