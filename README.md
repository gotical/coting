# 🐱 Coting — открытый кодинг-агент для Termux и смартфонов

**Coting (Котинк)** — автономный кодинг-агент, который целиком живёт в твоём телефоне:
Node-сервер в Termux + мобильный веб-чат + Android-приложение. Ноль облаков между
тобой и моделью: провайдера выбираешь сам (встроенные тарифы zcode или любой
Anthropic- / OpenAI-совместимый API со своим ключом).

> © 2026 **RybinskLab** (ИП Усачёв Д.Е.) — [rybinsklab.ru](https://rybinsklab.ru)

---

## Что умеет

- **Полноценный агент**: 7 инструментов — shell, чтение/запись/правка файлов, поиск по коду (ripgrep), скачивание страниц (`web_fetch`, ходит под UA мобильного Яндекс.Браузера), **управление телефоном** (`android_device`: тапы, свайпы, чтение экрана, скриншоты, системные кнопки, блокировка экрана).
- **Стриминг в реальном времени** (SSE): ответ печатается по мере генерации, шаги инструментов — сворачиваемые карточки.
- **Мульти-провайдер**: встроенные из `~/.zcode/v2/provider_config.json` (zai/alibaba/gemini/tokenwave) + свои аккаунты любого типа (Anthropic Messages или OpenAI-совместимый) — добавляются в веб-интерфейсе или из терминала, ключи остаются на устройстве.
- **История чатов** с персистентностью: полная Anthropic-история в JSON-файлах, переживает рестарты.
- **Безопасность**: сервер слушает только `127.0.0.1`; ключи никогда не покидают устройство и не отдаются в UI; опциональное подтверждение shell-команд (approval-флоу).
- **PWA**: «Добавить на главный экран» — иконка кота, без адресной строки.

## Установка в Termux (чистый телефон)

```bash
curl -fsSL https://raw.githubusercontent.com/gotical/coting/main/install.sh | bash
```

Скрипт сам поставит nodejs/ripgrep/git, скачает сервер, пропишет доступы и запустит чат.
Дальше:

| команда | что делает |
|---|---|
| `coting start` | сервер API+веб на `http://127.0.0.1:8395` |
| `coting web` | открыть чат в браузере сразу |
| `coting status` / `stop` / `restart` / `log` | управление |
| `coting provider list` | провайдеры и модели |
| `coting provider add <id> <baseUrl> <anthropic\|openai> <apiKey> <модели> [имя]` | свой аккаунт |
| `coting provider test <id>` | проверка ключа мини-запросом |
| `coting provider del <id>` | удалить свой провайдер |

## Android-приложение

Исходники — в [`android/`](android/). Сборка без Gradle прямо в Termux:

```bash
cd ~/coting/android
# один раз: свой keystore вместо отладочного
keytool -genkeypair -v -keystore keystore.jks -alias key -keyalg RSA -keysize 2048 -validity 10000 -storepass android
./build.sh
su -c "pm install -r coting.apk"   # или adb install -r coting.apk
```

Приложение — WebView-обёртка чата + интеграция с Termux:

- **🐾 Запустить сервер в Termux** — кнопка поднимает сервер через Termux `RUN_COMMAND` (нужно `allow-external-apps=true`, ставится install.sh);
- **Управление телефоном** (Accessibility): агент тапает/свайпает/читает экран/делает скриншоты — включается владельцем вручную в настройках, скрытых режимов нет;
- **Права администратора** (Device Admin, политика только force-lock): блокировка экрана по команде из чата;
- **📖 Инструкция** — установка в чистый Termux одной командой (копирование в буфер).

Мост приложения: локальный HTTP `127.0.0.1:8396` (`/status /tap /swipe /text /screenshot /action`) —Termux-агент дергает его инструментом `android_device`.

⚠️ Мост слушает только loopback, но Android-приложения делят localhost: на прошивках
без изоляции другие приложения могут стучаться к нему. Держи мост включённым только
когда нужен и добавь приложение в whitelist батареи (HyperOS любит морозить фон).

## Архитектура

```
~/coting/
├── server.js        HTTP: статика + API + SSE-стрим (порт 8395)
├── engine.js        агент: 7 инструментов, цикл tool-calling, стриминг
├── config.js        провайдеры: встроенные (zcode) + свои (~/.config/coting/config.json, chmod 600)
├── cli.js           управление провайдерами из терминала
├── public/          веб-чат (vanilla JS, marked+hljs+DOMPurify vendored), PWA-манифест
├── android/         исходники APK (Java, без Gradle; aapt2→javac→d8→apksigner)
├── termux/          скрипты coting и cotingd
├── sessions/        история чатов (JSON, в git не попадает)
└── install.sh       установка одной командой
```

Инструменты агента: `run_command`, `read_file`, `write_file`, `edit_file`, `list_dir`,
`search_files`, `web_fetch` (UA Яндекс.Браузера Mobile), `android_device` (мост APK).

## Приватность

- Ключи — только на устройстве (`~/.zcode/v2/provider_config.json` или `~/.config/coting/config.json`).
- Сервер и мост — только `127.0.0.1`.
- Accessibility и Device Admin включаются вручную владельцем и видны в системных настройках.
- Никакой телеметрии.

## Лицензия и автор

**© 2026 RybinskLab** — [rybinsklab.ru](https://rybinsklab.ru), автор проекта —
ИП Усачёв Денис Евгеньевич (Рыбинск). Проект открытый: форкай, дорабатывай,
делай своего кота.
