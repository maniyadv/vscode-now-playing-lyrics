import * as vscode from 'vscode';

export class LyricsPanel {
    public static currentPanel: LyricsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent('Loading lyrics...');
    }

    public static createOrShow() {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (LyricsPanel.currentPanel) {
            LyricsPanel.currentPanel._panel.reveal(column);
            return LyricsPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'lyricsView',
            'Now Playing Lyrics',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        LyricsPanel.currentPanel = new LyricsPanel(panel);
        return LyricsPanel.currentPanel;
    }

    public updateLyrics(lyrics: string, songInfo: { artist: string; title: string }) {
        if (this._panel) {
            this._panel.webview.html = this._getWebviewContent(lyrics, songInfo);
        }
    }

    private _getWebviewContent(lyrics: string, songInfo?: { artist: string; title: string }) {
        const formattedLyrics = lyrics.split('\n').join('<br>');
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                        padding: 20px;
                        line-height: 1.6;
                    }
                    .song-info {
                        margin-bottom: 20px;
                        padding-bottom: 10px;
                        border-bottom: 1px solid var(--vscode-textSeparator-foreground);
                    }
                    .title {
                        font-size: 1.5em;
                        font-weight: bold;
                        color: var(--vscode-textLink-foreground);
                    }
                    .artist {
                        font-size: 1.2em;
                        color: var(--vscode-textPreformat-foreground);
                    }
                    .lyrics {
                        font-size: 1.1em;
                        white-space: pre-wrap;
                        color: var(--vscode-editor-foreground);
                    }
                    .lyrics-container {
                        max-height: calc(100vh - 100px);
                        overflow-y: auto;
                        padding-right: 10px;
                    }
                </style>
            </head>
            <body>
                ${songInfo ? `
                    <div class="song-info">
                        <div class="title">${songInfo.title}</div>
                        <div class="artist">${songInfo.artist}</div>
                    </div>
                ` : ''}
                <div class="lyrics-container">
                    <div class="lyrics">${formattedLyrics}</div>
                </div>
            </body>
            </html>
        `;
    }

    public dispose() {
        LyricsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
