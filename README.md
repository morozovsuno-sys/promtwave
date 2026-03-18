# PromtWaveSuno v2.6

Suno Prompt Studio — генератор промптов для Suno AI с системой подписок и оплатой через ЮKassa.

## Возможности

- Генерация промптов для Suno AI по стилям и жанрам
- Регистрация и авторизация пользователей (JWT)
- Система подписок: Free / Pro / Ultra
- Оплата через ЮKassa (встроенный виджет)
- Личный кабинет с историей промптов
- Админ-панель: управление пользователями, статистика
- Деплой на Railway + PostgreSQL

## Технологии

- **Frontend**: HTML, CSS, JavaScript (Vanilla)
- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL
- **Auth**: JWT + bcryptjs
- **Payments**: YooKassa API
- **Deploy**: Railway

## Установка и запуск

### 1. Клонируй репозиторий
```bash
git clone https://github.com/morozovsuno-sys/promtwave.git
cd promtwave
```

### 2. Установи зависимости
```bash
npm install
```

### 3. Настрой переменные окружения
```bash
cp .env.example .env
# Заполни .env своими данными
```

### 4. Запусти
```bash
npm start
```

## Деплой на Railway

1. Подключи репозиторий к Railway
2. Добавь PostgreSQL плагин
3. Задай переменные из `.env.example` в Railway Variables
4. Railway автоматически запустит `npm start`

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/register | Регистрация |
| POST | /api/login | Вход |
| GET | /api/me | Профиль |
| POST | /api/prompts | Создать промпт |
| GET | /api/prompts | История промптов |
| POST | /api/payment/create | Создать платёж |
| POST | /api/payment/webhook | Webhook ЮKassa |
| GET | /api/admin/users | Список пользователей |
| GET | /api/admin/stats | Статистика |

## Лицензия

MIT
