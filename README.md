# Surfing

Embedded browser: open websites as workspace tabs with isolated profiles, history and ad-blocking — and let the assistant drive pages (navigate, click, fill forms, screenshot).

Web audio uses Valley’s shared media coordinator while its tab, embed, or URL file is open. Managed guests start muted and become audible only after the coordinator accepts playback. Readable HTML players expose confirmed transport controls and one-second position samples; state changes publish immediately. Players inside inaccessible frames or using Web Audio expose only native output muting, without claiming their internal timeline stopped. Closing the owning surface silences and destroys its guest, so web audio does not continue in the background. Lost command confirmations remain unknown and are never replayed automatically.

Open `.url` Internet shortcuts to view their saved HTTP(S) website. Edit the address and choose **Save URL** (or press Enter) to update the shortcut while preserving its other fields and line endings. **Reload file** discards the address draft and reads the latest file. Conflicting external edits are never overwritten.

Open `.mhtml` and `.mht` archives as read-only offline pages with captured styles, images, and fonts. Scripts, forms, live links, frames, and network requests are disabled; links within the saved page remain usable. Resources missing from the archive remain unavailable.

Open `.har` files in a read-only HTTP request inspector. Search requests and select a row to inspect headers, cookies, query parameters, request payloads, captured text/JSON responses, and timings. Binary and uncaptured response bodies are identified without execution. Requests are never replayed.

The assistant tool `browser_fetch_url` fetches a URL and returns its readable content as Markdown. HTML is reduced to the main article with absolute links; JSON is pretty-printed and plain text passes through. Fetches run in the plugin backend without cookies. HTTP is upgraded to HTTPS; private and local hosts are blocked. Responses are limited to 4 MiB, and at most 5 redirects are followed. Long results are paged with `maxChars` and `startIndex`, and a fetched page is reused for 10 minutes. With `render: true`, the page loads in one visible Surfing tab and is read after its scripts run. Every fetch appears live in the sidebar's **Assistant** list, which is kept only for the current session; select a row to open the page. The `surfing:fetch` command (`surfing fetch <url> [--max-chars N] [--start-index N]` in the CLI) is free under every guard preset. The visible-tab `surfing:fetch-rendered` command asks for confirmation under Recommended and is denied under Read-only.

Archive viewers reload after external file changes and provide **Reload file** for retrying failed or changed reads. Reads use temporary read-only vault storage grants and 512 KiB chunks. Files and expanded preview resources are limited to 64 MiB; MHTML parsing also limits nesting to 20 levels and MIME parts to 10,000. HAR lists show 100 requests per page. No archive content is written or uploaded.

This repository owns the plugin’s interface, behavior, dependencies, schemas, tests, translations, and compiled releases. It uses Valley manifest API 5 and the injected SDK 6.

This is an external plugin and is not bundled with Valley. An installed copy lives in the vault's `.valley/plugins/packages/github/surfing/` (installed from GitHub) or `.valley/plugins/packages/local/surfing/` (installed from a local package). Core and external installations run with the same sandbox, permissions, and SDK/IPC contract. Ordinary vault documents and saved plugin data (`.valley/plugins/data/surfing/`) keep their existing locations.

## Markdown embeds

Use one fence name: `surfing` for a website, `surfing youtube` for a YouTube embed, and `surfing X` for an X post. Put the URL in the block body or after the provider selector. Custom providers use `surfing <provider language>`.

The `providers.delete` command removes a custom provider's files, or a built-in provider's customization, with the revisions from `providers.list`. It also removes that provider's catalog entry, so deleting a provider right after `providers.create` or `providers.customize` restores the earlier files exactly.

Settings → Markdown → Code blocks has one Surfing name input. Renaming it changes the prefix for every Surfing example. Existing notes are not rewritten; update their fences to the selected prefix and provider selector.

````markdown
```surfing
https://example.com
```

```surfing youtube
https://youtu.be/M7lc1UVf-VE
```

```surfing X
https://x.com/jack/status/20
```
````

Provider names are case-insensitive. Add `height: 480` on a separate line for a custom height.

## Package

- `manifest.json`: readable English identity, version, and paired `author` / `authorUrl` arrays.
- `config.json`: runtime entry points, permissions, contributions, and storage declarations.
- `src/`: plugin interface and background engine.
- `src/wasm/`: the ad-block kernel in Rust on Brave's `adblock` crate (MPL-2.0), built to `runtime/assets/filters.wasm` and declared in `config.json` under `runtime.wasm`. Requires Valley 1.0.0 or later.
- `locales/`: English, German, Spanish, French, and Simplified Chinese catalogs.
- `tests/`: package-owned checks using the portable SDK testkit.
- `runtime/`: compiled installation artifact, including the package’s locale catalogs.
- `vendor/`: pinned SDK, testkit, and build-tool archives for independent development.

The package’s `manifest.name` and `manifest.description` catalog entries translate its identity, including while disabled. Missing translations fall back to this package’s English catalog. A plugin never falls back to Valley’s catalog or another plugin’s catalog.

## Development and releases

Use Node 24.19.0 and npm 11.17.0, and Rust from `rustup` (the toolchain pinned in `rust-toolchain.toml`) with binaryen's `wasm-opt` at the version plugin-tools names. From this repository, run:

```sh
npm ci
npm run check
```

The check validates types and package boundaries, runs the package tests, and rebuilds `runtime/`. It requires no Valley source checkout. Keep the rebuilt runtime, locale files, dependency lock, and vendored tools with each release. Increment the package and manifest versions together.

Valley release maintainers explicitly import the compiled artifact into the application’s `plugins.lock.json`; building Valley does not build or read this repository. All privileged work uses declared SDK capabilities, authenticated IPC, and explicit grants. Disabling or unloading the plugin releases its subscriptions and resources.

## Workflow integration

The backend explicitly registers its supported blocks through `registerWorkflowContribution`. Workflow calls the owning operations with their original authentication, cancellation, grants, revisions, and receipts. The catalogue publishes Draft-07 parameter and port contracts; credential administration and approval bypasses are excluded. Workflow availability is configured separately in Workflow → Plugins. Existing account, connection, and profile settings remain owned by this plugin.

Workflow output collections are explicit: `profiles.list` → `$.profiles`, `saved.list` → `$.pages`, `history.list` → `$.pages`, `providers.list` → `$.providers`. Selectors are relative to each execution item’s `json`. Profiles and providers deliberately select their primary records; cleanup IDs, customization IDs, issues and revisions remain metadata. Fetched page content remains one result.
