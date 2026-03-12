# Предскажи — Telegram Mini App

Мини-приложение для Telegram: пользователи делают предсказания по ежедневным вопросам, набирают очки и соревнуются в рейтинге.

## Структура

```
predict-app/
├── server.js          # Express API сервер
├── bot.js             # Telegram бот
├── database.js        # SQLite база данных
├── public/
│   └── index.html     # Фронтенд Mini App
├── package.json
├── .env.example
└── README.md
```

## Быстрый старт

### 1. Установка

```bash
cd predict-app
npm install
```

### 2. Настройка

Скопируй `.env.example` в `.env` и заполни:

```bash
copy .env.example .env
```

Отредактируй `.env`:
```
BOT_TOKEN=123456:ABC-DEF...       # Токен от @BotFather
WEBAPP_URL=https://your-domain.com # URL где будет хоститься приложение
PORT=3000
```

### 3. Получение токена бота

1. Открой [@BotFather](https://t.me/BotFather) в Telegram
2. Отправь `/newbot`
3. Задай имя и username
4. Скопируй токен в `.env`

### 4. Запуск

```bash
# Сервер API
npm start

# Бот (в отдельном терминале)
node bot.js
```

### 5. Настройка Mini App

1. В @BotFather отправь `/mybots` → выбери бота → Bot Settings → Menu Button
2. Укажи URL: `https://your-domain.com`
3. Или настрой через `/setmenubutton`

## Деплой

Для продакшена рекомендуется:

- **Railway / Render / VPS** — для сервера
- **Cloudflare Tunnel / ngrok** — для тестирования
- **HTTPS обязателен** — Telegram Mini Apps работают только по HTTPS

### Быстрый тест с ngrok:

```bash
npm start
# В другом терминале:
ngrok http 3000
```

Скопируй HTTPS-ссылку от ngrok в `.env` как `WEBAPP_URL` и в настройки бота.

## API

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/auth` | Авторизация пользователя |
| GET | `/api/questions?userId=` | Список активных вопросов |
| POST | `/api/predict` | Сделать предсказание |
| GET | `/api/leaderboard` | Топ-50 игроков |
| GET | `/api/stats/:userId` | Статистика пользователя |
