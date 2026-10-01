# Запуск контейнера

## Публикация без ручных registry credentials

В репозитории подготовлен workflow `.github/workflows/docker-publish.yml`. Он запускается только вручную: GitHub → Actions → Publish Docker image → Run workflow. После загрузки изменений в GitHub workflow проверяет тесты и публикует образы для amd64 и arm64, используя встроенный GITHUB_TOKEN. Ручной Docker Hub аккаунт или PAT не нужны. Для текущего репозитория имя будет `ghcr.io/lanser0614/routing-lab-ui:latest`.

После первой публикации установить у package visibility **Public** в GitHub Packages, чтобы сервер скачивал образ без docker login. Пока workflow не выполнен, этого образа в registry может не быть. Сам workflow не меняет видимость package. Публичный образ делает доступными код приложения и включённые тестовые данные; credentials в нём нет. Документация: [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Образ содержит Node.js, зависимости, приложение, тестовые данные, редактор vi и шаблон настроек. При первом запуске создаётся `/app/.env` и SQLite-база. Kafka по умолчанию выключена: сразу открывается лаборатория с импортированными заказами и примером 01.10.2026, 13:00–14:00. Расчёт дороги локальный, без платных запросов.

После публикации образа (заменить IMAGE на имя в registry):

```sh
docker pull IMAGE
docker run -d --name routing-lab --init --restart unless-stopped -p 3000:3000 IMAGE
docker exec -it routing-lab vi /app/.env
docker restart routing-lab
docker logs --tail 100 routing-lab
```

Интерфейс: `http://SERVER:3000`. В vi: i — редактировать; Esc, затем :wq и Enter — сохранить и выйти. Для Kafka задать KAFKA_OBSERVER_ENABLED=true, KAFKA_BROKERS, KAFKA_USERNAME, KAFKA_PASSWORD и при необходимости KAFKA_CA_LOCATION. Сертификат можно скопировать через `docker cp ca.pem routing-lab:/app/ca.pem`, затем указать этот путь. [Настройки Kafka и ограничения](kafka-observer.md).

При включении Kafka автоматически создаётся отдельная `/app/data/observer.sqlite`. Тестовые заказы в неё не попадают. Собственные группы consumer, фильтр филиала и режим наблюдения уже настроены. Брокеры должны быть доступны с сервера, включая адреса advertised listeners. При неверных credentials процесс завершается; исправить файл можно даже в остановленном контейнере:

```sh
docker cp routing-lab:/app/.env ./routing-lab.env
vi routing-lab.env
docker cp ./routing-lab.env routing-lab:/app/.env
docker restart routing-lab
```

Значения, переданные через `docker run -e` или `--env-file`, имеют приоритет над внутренним `.env`: для редактирования внутри использовать запуск без них. Если меняется PORT, изменить также публикацию порта при создании контейнера; проще оставить PORT=3000. Healthcheck читает PORT из внутреннего `.env`.

`docker restart` сохраняет настройки и SQLite внутри того же контейнера. **docker pull сам по себе ничего не очищает**. Новый чистый экземпляр создаётся при удалении старого контейнера и запуске нового. Volumes намеренно не объявлены:

```sh
docker pull IMAGE
docker stop routing-lab
docker rm routing-lab
docker run -d --name routing-lab --init --restart unless-stopped -p 3000:3000 IMAGE
```

Этот вариант сбрасывает локальные данные и `.env`; после обновления настройки нужно задать заново. Kafka offsets остаются в брокере: та же группа продолжит с подтверждённого offset, хотя локальная база пуста. Для повторного чтения доступной истории задать новое KAFKA_CONSUMER_GROUP и KAFKA_FROM_BEGINNING=true. Уже удалённые Kafka retention события восстановить нельзя.

Сборка из репозитория:

```sh
docker build -t routing-lab:local .
docker run -d --name routing-lab --init --restart unless-stopped -p 3000:3000 routing-lab:local
```

Публикация для серверов amd64 и arm64:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t IMAGE --push .
```

Локальные `.env`, SQLite, backups, `.git` и node_modules не входят в build context. Секреты задаются только после запуска. Контейнер работает от пользователя node.
