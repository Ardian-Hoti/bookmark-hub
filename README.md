# BookmarkHub

BookmarkHub is a Chrome extension that replaces the default new tab page with a simple interface for viewing and organizing your bookmarks.

It focuses on making bookmarks easier to browse, search, and manage without relying on external services.

## What it does

- Opens a dedicated tab with your bookmarks when clicking the extension icon
- Lets you organize bookmarks using folders, tags, and categories
- Provides fast search (title, URL, tags)
- Displays recently added bookmarks
- Supports grid and list layouts
- Includes a dark theme

## Why this exists

Chrome’s default bookmark manager is hard to navigate once you have a lot of saved links.

This project is a lightweight alternative that:

- keeps everything local (no external database)
- gives a better overview of bookmarks
- makes searching and organizing faster

## Installation (local)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select this project folder

## Usage

- Click the extension icon to open BookmarkHub in a new tab
- Use the sidebar to filter bookmarks
- Use the search bar to quickly find anything
- Click a bookmark to view or edit its details

## Tech

- Vanilla JavaScript
- Chrome Extensions API (bookmarks)
- No external dependencies

## Notes

- All data stays in your browser (uses Chrome bookmarks)
- No tracking, no backend, no cloud sync (relies on Chrome sync if enabled)

## Contributing

Feel free to fork, improve, or adapt it to your needs.
