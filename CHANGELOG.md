# Изменения

## 0.1.0 — experimental, не опубликовано

- Неизменяемые `Requirement` и `DynamicLayer.fromLayer/fromEffect` с проверяемыми входами и output service.
- Scoped `DynamicRuntime`: регистрация, enable/disable, replace/unregister, retry; атомарная валидация DAG и инвалидация затронутой ветки.
- Чистый переход управляющих команд со строковых node ids на реальные `Context` services; экспортированы `LifecycleState` constants, target разрешается по полному реестру, а `awaitState` закрепляется за identity выбранной регистрации.
- Отдельные поколения, Scope/MemoMap, ordered teardown и stop-before-start replacement без перезапуска независимых ветвей.
- Реактивные boolean gates и managed `use` с caller Context, отменой и учётом cleanup.
- Диагностические snapshots, безопасные summaries Cause, cancellable state/idle waits и идемпотентный shutdown.
- Непрерываемый shutdown drain, сохранение ошибок release и консервативная quarantine составных build defects; ограничения описаны в README и ADR.
- Effect `4.0.0-rc.115` как точный peer, Bun `1.4.2` для установки, тестов и сборки; TypeScript strict/declarations, Biome и Lefthook.
- Исполняемые примеры, отрицательные type-tests и внешний consumer собранного tarball.

Фактические результаты и матрица T01–T40: [docs/status.md](docs/status.md). Production-ready, browser-совместимость и поддержка других Effect RC не заявляются.
