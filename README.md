# SQL Context Generator VS Code Extension

This repository contains a Visual Studio Code extension that can connect to PostgreSQL, MySQL and SQLite databases, extract schema information and generate a Markdown context file for the currently opened workspace.

## Features

- Securely store connection details per workspace using VS Code secret storage.
- Support PostgreSQL, MySQL and SQLite connections.
- Import/export connection configuration using `.env` formatted text (clipboard, manual paste or file based).
- Generate Markdown files summarising database tables and columns.
- Customise the output path and file name template (supports ISO timestamp placeholders).

## Commands

| Command | Description |
| --- | --- |
| **SQL Context: Configure Database Connection** | Interactively configure the connection for the active workspace. |
| **SQL Context: Generate Context Markdown** | Query the configured database and generate a Markdown context file. |
| **SQL Context: Import Connection From .env** | Import connection settings from pasted content, the clipboard or a `.env` file. |
| **SQL Context: Export Connection To .env** | Export the stored connection to `.env` format and copy it to the clipboard. |

You can execute commands from the Command Palette (`Ctrl/Cmd + Shift + P`).

## `.env` Format

The following keys are supported when importing/exporting connection settings:

| Provider | Required Keys | Optional Keys |
| --- | --- | --- |
| PostgreSQL/MySQL | `DB_TYPE`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `DB_SSL` (`true`/`false`) |
| SQLite | `DB_TYPE`, `DB_FILE` | – |

`DB_TYPE` accepts `postgres`, `mysql` or `sqlite`.

## Output File Template

The default output path template is `context/context-${isoDate}.md`. You can change it via the `sql-context.outputPathTemplate` setting. The following placeholders are available:

- `${isoDate}` / `${date}` / `{{isoDate}}` / `{{date}}` – ISO timestamp (with characters safe for file names).
- `${workspaceFolder}` – absolute path to the workspace folder.
- `${workspaceName}` – name of the workspace folder.

When running the “Generate Context Markdown” command you can override the final path manually before the file is written.
