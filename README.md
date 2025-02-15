# Now Playing Lyrics

Display synchronized lyrics for your currently playing songs directly in VSCode's status bar! Supports both Apple Music and Spotify on macOS.

![Demo](images/demo.gif)

## Features

- 🎵 Real-time synchronized lyrics that follow along with your music
- 🎨 Smooth animations and word highlighting
- 🎧 Support for both Apple Music and Spotify
- 🌐 Multiple lyrics sources for better coverage
- 🔄 Automatic song change detection
- ⚡️ Fast and lightweight

## Installation

1. Install from the VSCode Marketplace
2. No configuration needed! Just start playing music in Apple Music or Spotify

## Security Analysis

This extension is designed with security in mind:

### Data Collection
- Only collects currently playing song information (title, artist) from local Apple Music/Spotify
- No personal data or listening history is stored
- No analytics or telemetry

### API Usage
- Uses public APIs from lrclib.net, Netease, and QQ Music
- Only sends song title and artist name to search for lyrics
- No authentication or personal data sent
- All requests are HTTPS encrypted

### Local Access
- Only uses AppleScript to get currently playing song info
- No file system access needed
- No sensitive permissions required

### Privacy
- No data stored between sessions
- No cookies or local storage used
- No tracking or user identification

## Known Limitations

1. Only works on macOS (due to AppleScript usage)
2. Some songs may not have synchronized lyrics available
3. Lyrics accuracy depends on the source databases

## Contributing

Contributions are welcome! Please check out our [Contributing Guide](CONTRIBUTING.md).

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Credits

Thanks to:
- lrclib.net
- Netease Music API
- QQ Music API

## Support

If you encounter any issues or have suggestions, please file them in our [GitHub repository](https://github.com/yourusername/vscode-now-playing-lyrics/issues).
