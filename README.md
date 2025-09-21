# SQL Context Generator VS Code Extension

Расширение позволяет генерировать файлы контекста в формате Markdown на основе структуры базы данных в текущем проекте. Поддерживаются MySQL, PostgreSQL и SQLite. Для каждого workspace сохраняются собственные настройки подключения, которые хранятся в Secret Storage VS Code и не требуют повторного ввода после перезапуска.

## Возможности

- Подключение к MySQL, PostgreSQL или SQLite.
- Хранение параметров подключения в защищённом Secret Storage для каждого workspace.
- Импорт и экспорт настроек подключения в формате `.env` (вставка из многострочного поля или выбор файла, копирование в буфер обмена).
- Генерация Markdown-файла с описанием таблиц и столбцов выбранной базы данных.
- Настройка расположения и шаблона имени выходного файла, поддержка плейсхолдера `${ISO_DATE}` для уникальности.

## Команды

Команды доступны через `Ctrl+Shift+P` → ввод `SQL Context`:

- **SQL Context: Configure Database Connection** – настройка параметров подключения вручную.
- **SQL Context: Import Connection from .env** – импорт параметров из `.env` (вставка в открытое многострочное поле или выбор файла).
- **SQL Context: Export Connection to .env** – экспорт текущих параметров в `.env` и копирование в буфер обмена.
- **SQL Context: Generate Markdown Context** – генерация Markdown-файла со структурой базы данных.

## Формат `.env`

Пример содержимого:

```env
DB_TYPE=postgres
DB_HOST=localhost
DB_PORT=5432
DB_USER=user
DB_PASSWORD=secret
DB_NAME=database
DB_SCHEMA=public
DB_SSL=true
```

Для SQLite требуется указать путь к файлу базы данных:

```env
DB_TYPE=sqlite
DB_FILE=/path/to/database.sqlite
```

## Шаблон имени файла

В настройках расширения доступен параметр `ext-sql-context.defaultOutputPattern`. Значение задаётся относительно корня проекта. Поддерживается плейсхолдер `${ISO_DATE}`, который заменяется на текущую дату/время в формате ISO (символы `:` и `.` заменяются на `-`). Пример: `context/context-${ISO_DATE}.md` → `context/context-2024-01-01T12-30-00-000Z.md`.

## Сборка

```bash
npm install
npm run compile
```

Скомпилированные файлы попадают в папку `out/`.
