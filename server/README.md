# Сервер синхронизации (money-sync)

Маленький сервер для синхронизации приложения между устройствами.
Node.js ≥ 22.13 (встроенный `node:sqlite`), одна зависимость — `bcryptjs` (чистый JS, без компиляции).
Данные — один файл SQLite. Память: ~55–70 МБ RSS (это базовый расход Node), CPU в простое ≈ 0.

## API
- `POST /api/login {password}` → `{token}` (сессия 180 дней; 10 неверных попыток → блок IP на 15 мин)
- `POST /api/logout` (Bearer)
- `POST /api/sync {since, changes:[{store,id,updatedAt,deleted,data}]}` (Bearer) → `{accepted, changes, cursor, more}`
  Last‑write‑wins по `updatedAt`, удаления — «надгробия» (`deleted:true`), выдача изменений по монотонному `seq` сервера.
- `GET /api/health`
Путь может быть с любым префиксом (`/money/api/sync` тоже работает).

## Что нужно для деплоя
1. SSH-доступ с sudo, Ubuntu с Node ≥ 22.13 (`node -v`). Если версия ниже — поставить Node 22 LTS (NodeSource или `n`); существующие node‑приложения можно оставить на своей версии, если они запущены через свой путь.
2. Домен/поддомен с HTTPS (приложение открыто на https://milcford.github.io, браузер не пустит запросы на http).
3. Свободный порт на 127.0.0.1 (по умолчанию 8787; проверить: `ss -ltnp | grep 8787`).

## Установка
```bash
sudo useradd --system --home /var/lib/money-sync --shell /usr/sbin/nologin money
sudo mkdir -p /opt/money-sync /var/lib/money-sync && sudo chown money:money /var/lib/money-sync
# скопировать server.js, package.json, package-lock.json в /opt/money-sync
cd /opt/money-sync && sudo npm ci --omit=dev
echo -n 'ВАШ_ДЛИННЫЙ_ПАРОЛЬ' | node server.js hash      # → $2a$10$....
sudo cp deploy/money-sync.env.example /etc/money-sync.env && sudo chmod 600 /etc/money-sync.env
sudo nano /etc/money-sync.env                                # вставить хеш, проверить PORT
sudo cp deploy/money-sync.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now money-sync
curl -s 127.0.0.1:8787/api/health                            # {"ok":true}
```
Затем добавить блок из `deploy/nginx.conf.example` или `deploy/Caddyfile.example`, `sudo nginx -t && sudo systemctl reload nginx`.
В приложении: История → ⋯ → ☁ Синхронизация → адрес (`https://домен/money` или `https://money.домен`) и пароль.

## Обслуживание
- Логи: `journalctl -u money-sync -f`
- Бэкап: `sqlite3 /var/lib/money-sync/money.db ".backup /var/backups/money-$(date +%F).db"` (или просто копировать файл при остановленном сервисе)
- Смена пароля: новый хеш в `/etc/money-sync.env`, `systemctl restart money-sync` (старые сессии продолжают работать; чтобы выкинуть все — удалить таблицу sessions: `sqlite3 money.db "DELETE FROM sessions"`).
- Часы устройств должны быть примерно верными (LWW сравнивает время изменения).
