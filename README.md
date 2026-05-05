# Jarvis — Electron Desktop App

AI-powered desktop assistant built with Electron + Next.js.

## Development

```bash
npm install
npm run dev
```

This starts the Next.js dev server and Electron simultaneously.

## Build & Package

### macOS (DMG)
```bash
npm run dist:mac
```
Outputs a `.dmg` installer in `release/`.

### Windows (EXE / NSIS installer)
```bash
npm run dist:win
```
Outputs an NSIS `.exe` installer in `release/`.

### Both platforms
```bash
npm run dist
```

## Requirements

- **Node.js 18+**
- **Python 3** with `mss`, `pyautogui`, `openai`, `Pillow` (for computer-use feature)
- **OpenAI API key** — enter in the Jarvis Settings panel at runtime

## Environment

Copy `env.example` to `.env.local` for local dev if needed:

```
NEXT_PUBLIC_OPENAI_API_KEY=sk-proj-...
```

The app also accepts the API key via the Settings modal (stored in `localStorage`).

## Icon

Place your app icons in `buildfiles/`:
- `icon.icns` — macOS
- `icon.ico` — Windows
- `icon.png` — Fallback (512×512 recommended)

If no icons are present, electron-builder will use defaults.
