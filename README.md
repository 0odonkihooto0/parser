# Parser

Локальное приложение для парсинга веб-страниц и документов на базе [Firecrawl](https://firecrawl.dev).

**Режимы работы:**
- **Scrape** — извлечение контента одной страницы в Markdown
- **Crawl** — обход нескольких страниц сайта (до 10)
- **Parse** — парсинг документов: PDF, XLSX, XLS, DOCX, DOC

## Установка

### 1. Получите API-ключ

Зарегистрируйтесь на [firecrawl.dev](https://firecrawl.dev) и получите API-ключ в личном кабинете.

### 2. Настройте окружение

```bash
cp server/.env.example server/.env
```

Откройте `server/.env` и вставьте ваш ключ:

```
FIRECRAWL_API_KEY=fc-ваш_ключ_здесь
```

### 3. Установите зависимости и запустите

```bash
npm install
npm run dev
```

### 4. Откройте приложение

Перейдите в браузере по адресу: [http://localhost:5173](http://localhost:5173)

## Запуск через Docker

### 1. Установите Docker Desktop

Скачайте и установите [Docker Desktop](https://www.docker.com/products/docker-desktop/) для вашей ОС (Windows / macOS / Linux).

### 2. Клонируйте репозиторий

```bash
git clone https://github.com/0odonkihooto0/parser.git
cd parser
```

### 3. Настройте API-ключ

```bash
cp .env.example .env
```

Откройте `.env` и вставьте ключ от [firecrawl.dev](https://firecrawl.dev):

```
FIRECRAWL_API_KEY=fc-ваш_ключ
```

### 4. Запустите

```bash
docker compose up --build
```

### 5. Откройте приложение

Перейдите в браузере: [http://localhost:4000](http://localhost:4000)

### Остановка

```bash
docker compose down
```

Данные (SQLite) сохраняются в Docker volume `parser-data` и переживают перезапуск.

### Self-hosted Firecrawl (без API-ключа)

Если не хотите использовать облачный Firecrawl, можно поднять его локально:

```bash
docker compose -f docker-compose.selfhosted.yml up --build
```

Это поднимет 4 контейнера: app, firecrawl-api, firecrawl-worker, redis.

---

## Продакшн-сборка

```bash
npm run build
npm start
```

Клиент собирается в `client/dist/`, Express раздаёт его как статику.
Приложение доступно на [http://localhost:4000](http://localhost:4000).

## Стек

| Компонент | Технология |
|-----------|------------|
| Frontend  | React + Vite |
| Backend   | Node.js + Express |
| Парсинг   | Firecrawl JS SDK |
| Хранение  | SQLite (better-sqlite3) |
