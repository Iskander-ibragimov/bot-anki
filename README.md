# Повтор — Telegram-бот для английских слов

Бот учит английские слова методом интервальных повторений, как AnkiDroid: алгоритм FSRS-6, четыре кнопки оценки («Снова / Трудно / Хорошо / Легко»), шаги обучения 1 и 10 минут. Перевод и пример спрятаны под спойлером, прогресс копится, свои слова можно добавлять со ссылкой на источник.

Работает на бесплатном тарифе Cloudflare Workers + D1. Спека и план лежат в `docs/superpowers/`, кликабельный драфт — в `draft/`.

## Как развернуть

Секреты репозитория (Settings → Secrets and variables → Actions):

| Секрет | Откуда |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens, шаблон «Edit Cloudflare Workers» + Account → D1 → Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers & Pages, справа |
| `BOT_TOKEN` | @BotFather |
| `ADMIN_TG_ID` | ваш числовой ID (@userinfobot) |
| `GROQ_API_KEY`, `OPENROUTER_API_KEY` | console.groq.com, openrouter.ai |
| `WEBHOOK_SECRET` | любая случайная строка из латиницы и цифр, 32+ символа |

Каждый push в `master` запускает **Deploy**: тесты, создание базы D1 (если её нет), миграции, загрузка колод, выкладка воркера, секреты, регистрация вебхука и команд в Telegram. Запустить вручную: Actions → Deploy → Run workflow.

Модели AI выбираются автоматически из доступных на Groq и OpenRouter. Зафиксировать модель можно переменными репозитория `GROQ_MODEL` и `OPENROUTER_MODEL` (Settings → Variables).

## Другие действия (Actions)

- **Voice catalog decks** — необязательно. Озвучка работает и без этого: при первом нажатии 🔊 слово синтезируется через Cloudflare Workers AI и кэшируется. Этот запуск заранее озвучивает все слова голосом Piper.
- **Expand a catalog deck with AI** — добавить в колоду N новых слов через бесплатный AI.
- **Weekly D1 backup** — еженедельная выгрузка базы (артефакт хранится 90 дней). Кроме того, у D1 есть восстановление на любой момент за 7 дней.

## Админ

- `/admin` — активность, повторы и расход дневного лимита D1.
- Отправьте боту CSV (`word,ipa,pos,translation,example_en,example_ru`) с подписью `deck: Название | Title | A2` — появится новая колода.
- При 80 % дневного лимита записей D1 бот пришлёт предупреждение.

## Разработка

```
pnpm install
pnpm test        # Vitest в рантайме Workers с настоящей D1
pnpm typecheck
pnpm depcruise   # правила слоёв
```
