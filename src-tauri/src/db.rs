use std::{collections::HashSet, path::Path, sync::Mutex, time::Duration};

use chrono::{Local, TimeZone, Timelike};
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

use crate::models::{
    AppSettings, CreateTodoInput, DatabaseDiagnostics, ExportBundle, ImportPreview, ListTodosInput,
    RestorePreview, Todo, UpdateTodoInput, ZentaoSyncResult,
};
use crate::zentao::ExternalTask;

const MISSED_REMINDER_GRACE_MS: i64 = 24 * 60 * 60 * 1_000;
const MAX_PENDING_REMINDERS: i64 = 100;
const CURRENT_SCHEMA_VERSION: i64 = 4;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueReminder {
    pub todo_id: String,
    pub kind: String,
    pub title: String,
    pub deadline_at: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderAcknowledgement {
    pub todo_id: String,
    pub kind: String,
    pub deadline_at: i64,
}

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let existing_database = path.metadata().is_ok_and(|metadata| metadata.len() > 0);
        let connection = Connection::open(path).map_err(error_message)?;
        let version = schema_version(&connection)?;
        if existing_database && version < CURRENT_SCHEMA_VERSION {
            backup_before_migration(&connection, path, version)?;
        }
        Self::from_connection(connection)
    }

    #[cfg(test)]
    fn open_in_memory() -> Result<Self, String> {
        let connection = Connection::open_in_memory().map_err(error_message)?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> Result<Self, String> {
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(error_message)?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;",
            )
            .map_err(error_message)?;

        migrate(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    #[cfg(test)]
    pub fn list_todos(&self, input: &ListTodosInput) -> Result<Vec<Todo>, String> {
        self.query_todos(input, -1, 0)
    }

    pub fn list_todos_page(
        &self,
        input: &ListTodosInput,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Todo>, String> {
        if !(1..=500).contains(&limit) || !(0..=1_000_000_000).contains(&offset) {
            return Err("Todo 分页参数无效".to_string());
        }
        self.query_todos(input, limit, offset)
    }

    pub fn get_todo(&self, id: &str) -> Result<Todo, String> {
        validate_id(id)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        query_todo(&connection, id)?.ok_or_else(|| "Todo 不存在或已被删除".to_string())
    }

    fn query_todos(
        &self,
        input: &ListTodosInput,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Todo>, String> {
        validate_filter(&input.filter)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        let end_of_today = end_of_local_day_millis()?;
        let search = input.search.trim();
        let pattern = format!("%{}%", escape_like(search));

        let mut statement = connection
            .prepare(
                "SELECT id, title, body, status, priority, deadline_at, reminder_minutes,
                        completed_at, archived_at, created_at, updated_at, sort_order
                 FROM todos
                 WHERE deleted_at IS NULL
                   AND ((?1 = 'completed' AND status = 'completed')
                     OR (?1 = 'archived' AND status = 'archived')
                     OR (?1 NOT IN ('completed', 'archived') AND status = 'open'))
                   AND (?1 != 'today' OR (deadline_at IS NOT NULL AND deadline_at <= ?2))
                   AND (?3 = '' OR title LIKE ?4 ESCAPE '\\' COLLATE NOCASE
                                  OR body LIKE ?4 ESCAPE '\\' COLLATE NOCASE)
                 ORDER BY sort_order ASC,
                          CASE WHEN deadline_at IS NULL THEN 1 ELSE 0 END,
                          deadline_at ASC,
                          priority DESC
                 LIMIT ?5 OFFSET ?6",
            )
            .map_err(error_message)?;

        let rows = statement
            .query_map(
                params![input.filter, end_of_today, search, pattern, limit, offset],
                todo_from_row,
            )
            .map_err(error_message)?;

        rows.collect::<Result<Vec<_>, _>>().map_err(error_message)
    }

    pub fn create_todo(&self, input: &CreateTodoInput) -> Result<Todo, String> {
        validate_todo_input(
            &input.title,
            &input.body,
            input.priority,
            input.deadline_at,
            input.reminder_minutes,
        )?;

        let connection = self.connection.lock().map_err(lock_error)?;
        let id = Uuid::now_v7().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let sort_order: f64 = connection
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1024 FROM todos WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(error_message)?;
        let reminder_minutes = input.deadline_at.and(input.reminder_minutes);

        connection
            .execute(
                "INSERT INTO todos (
                    id, title, body, status, priority, deadline_at, reminder_minutes,
                    created_at, updated_at, sort_order
                 ) VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7, ?7, ?8)",
                params![
                    id,
                    input.title.trim(),
                    input.body,
                    input.priority,
                    input.deadline_at,
                    reminder_minutes,
                    now,
                    sort_order,
                ],
            )
            .map_err(error_message)?;

        query_todo(&connection, &id)?.ok_or_else(|| "新建 Todo 后无法读取记录".to_string())
    }

    pub fn update_todo(&self, input: &UpdateTodoInput) -> Result<Todo, String> {
        validate_id(&input.id)?;
        validate_todo_input(
            &input.title,
            &input.body,
            input.priority,
            input.deadline_at,
            input.reminder_minutes,
        )?;

        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(error_message)?;
        let previous_deadline = transaction
            .query_row(
                "SELECT deadline_at FROM todos WHERE id = ?1 AND deleted_at IS NULL",
                [&input.id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(error_message)?
            .ok_or_else(|| "Todo 不存在或已被删除".to_string())?;
        let now = chrono::Utc::now().timestamp_millis();
        let reminder_minutes = input.deadline_at.and(input.reminder_minutes);
        transaction
            .execute(
                "UPDATE todos
                 SET title = ?2, body = ?3, priority = ?4, deadline_at = ?5,
                     reminder_minutes = ?6, updated_at = ?7
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![
                    input.id,
                    input.title.trim(),
                    input.body,
                    input.priority,
                    input.deadline_at,
                    reminder_minutes,
                    now,
                ],
            )
            .map_err(error_message)?;
        if previous_deadline != input.deadline_at {
            transaction
                .execute("DELETE FROM reminder_inbox WHERE todo_id = ?1", [&input.id])
                .map_err(error_message)?;
            transaction
                .execute(
                    "DELETE FROM reminder_deliveries WHERE todo_id = ?1",
                    [&input.id],
                )
                .map_err(error_message)?;
        }
        transaction.commit().map_err(error_message)?;
        query_todo(&connection, &input.id)?.ok_or_else(|| "更新后无法读取 Todo".to_string())
    }

    pub fn set_completed(&self, id: &str, completed: bool) -> Result<Todo, String> {
        validate_id(id)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        let now = chrono::Utc::now().timestamp_millis();
        let status = if completed { "completed" } else { "open" };
        let completed_at = completed.then_some(now);
        let changed = connection
            .execute(
                "UPDATE todos
                 SET status = ?2, completed_at = ?3, archived_at = NULL, updated_at = ?4
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![id, status, completed_at, now],
            )
            .map_err(error_message)?;
        if changed == 0 {
            return Err("Todo 不存在或已被删除".to_string());
        }

        query_todo(&connection, id)?.ok_or_else(|| "更新后无法读取 Todo".to_string())
    }

    pub fn set_archived(&self, id: &str, archived: bool) -> Result<Todo, String> {
        validate_id(id)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        let now = chrono::Utc::now().timestamp_millis();
        let status = if archived { "archived" } else { "open" };
        let archived_at = archived.then_some(now);
        let changed = connection
            .execute(
                "UPDATE todos
                 SET status = ?2, archived_at = ?3, completed_at = NULL, updated_at = ?4
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![id, status, archived_at, now],
            )
            .map_err(error_message)?;
        if changed == 0 {
            return Err("Todo 不存在或已被删除".to_string());
        }

        query_todo(&connection, id)?.ok_or_else(|| "归档后无法读取 Todo".to_string())
    }

    pub fn reorder_todos(&self, ids: &[String]) -> Result<(), String> {
        if ids.len() > 10_000 {
            return Err("一次最多排序 10000 项 Todo".to_string());
        }
        let mut unique = HashSet::with_capacity(ids.len());
        for id in ids {
            validate_id(id)?;
            if !unique.insert(id) {
                return Err("排序列表包含重复 Todo".to_string());
            }
        }

        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(error_message)?;
        let now = chrono::Utc::now().timestamp_millis();
        for (index, id) in ids.iter().enumerate() {
            let changed = transaction
                .execute(
                    "UPDATE todos SET sort_order = ?2, updated_at = ?3
                     WHERE id = ?1 AND status = 'open' AND deleted_at IS NULL",
                    params![id, (index as i64 + 1) * 1024, now],
                )
                .map_err(error_message)?;
            if changed == 0 {
                return Err("只能排序当前未删除的待办 Todo".to_string());
            }
        }
        transaction.commit().map_err(error_message)
    }

    pub fn soft_delete(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        let now = chrono::Utc::now().timestamp_millis();
        let changed = connection
            .execute(
                "UPDATE todos SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
                params![id, now],
            )
            .map_err(error_message)?;
        if changed == 0 {
            return Err("Todo 不存在或已被删除".to_string());
        }
        Ok(())
    }

    pub fn restore_deleted(&self, id: &str) -> Result<Todo, String> {
        validate_id(id)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        let now = chrono::Utc::now().timestamp_millis();
        let changed = connection
            .execute(
                "UPDATE todos SET deleted_at = NULL, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id, now],
            )
            .map_err(error_message)?;
        if changed == 0 {
            return Err("Todo 不存在或未被删除".to_string());
        }
        query_todo(&connection, id)?.ok_or_else(|| "恢复后无法读取 Todo".to_string())
    }

    pub fn purge_deleted(&self) -> Result<usize, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute("DELETE FROM todos WHERE deleted_at IS NOT NULL", [])
            .map_err(error_message)
    }

    pub fn sync_external_todos(
        &self,
        source: &str,
        tasks: &[ExternalTask],
        default_reminder_minutes: i64,
    ) -> Result<ZentaoSyncResult, String> {
        if source != "zentao" {
            return Err("未知的外部任务来源".to_string());
        }
        if tasks.len() > 1_000 {
            return Err("一次最多同步 1000 项禅道任务".to_string());
        }
        if !(0..=525_600).contains(&default_reminder_minutes) {
            return Err("默认提醒提前量无效".to_string());
        }

        let mut created = 0;
        let mut updated = 0;
        let mut completed = 0;
        let mut skipped = 0;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(error_message)?;
        let now = chrono::Utc::now().timestamp_millis();

        for task in tasks {
            validate_todo_input(
                &task.title,
                &task.body,
                task.priority,
                task.deadline_at,
                task.deadline_at.and(Some(default_reminder_minutes)),
            )?;
            let existing: Option<(String, Option<i64>)> = transaction
                .query_row(
                    "SELECT t.id, t.deleted_at
                     FROM external_todos e
                     JOIN todos t ON t.id = e.todo_id
                     WHERE e.source = ?1 AND e.external_id = ?2",
                    params![source, task.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(error_message)?;

            if let Some((id, deleted_at)) = existing {
                if deleted_at.is_some() {
                    skipped += 1;
                    continue;
                }
                if task.open {
                    transaction
                        .execute(
                            "UPDATE todos
                             SET title = ?2, body = ?3, priority = ?4, deadline_at = ?5,
                                 reminder_minutes = CASE
                                    WHEN ?5 IS NULL THEN NULL
                                    ELSE COALESCE(reminder_minutes, ?6)
                                 END,
                                 status = 'open', completed_at = NULL, archived_at = NULL, updated_at = ?7
                             WHERE id = ?1 AND deleted_at IS NULL",
                            params![
                                id,
                                task.title.trim(),
                                task.body,
                                task.priority,
                                task.deadline_at,
                                default_reminder_minutes,
                                now
                            ],
                        )
                        .map_err(error_message)?;
                    updated += 1;
                } else {
                    transaction
                        .execute(
                            "UPDATE todos
                             SET title = ?2, body = ?3, priority = ?4, status = 'completed',
                                 completed_at = COALESCE(completed_at, ?5), archived_at = NULL, updated_at = ?5
                             WHERE id = ?1 AND deleted_at IS NULL",
                            params![id, task.title.trim(), task.body, task.priority, now],
                        )
                        .map_err(error_message)?;
                    completed += 1;
                }
                transaction
                    .execute(
                        "UPDATE external_todos SET last_synced_at = ?3 WHERE source = ?1 AND external_id = ?2",
                        params![source, task.id, now],
                    )
                    .map_err(error_message)?;
            } else if task.open {
                let id = Uuid::now_v7().to_string();
                let sort_order: f64 = transaction
                    .query_row(
                        "SELECT COALESCE(MAX(sort_order), 0) + 1024 FROM todos WHERE deleted_at IS NULL",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(error_message)?;
                let reminder_minutes = task.deadline_at.and(Some(default_reminder_minutes));
                transaction
                    .execute(
                        "INSERT INTO todos (
                            id, title, body, status, priority, deadline_at, reminder_minutes,
                            created_at, updated_at, sort_order
                         ) VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7, ?7, ?8)",
                        params![
                            id,
                            task.title.trim(),
                            task.body,
                            task.priority,
                            task.deadline_at,
                            reminder_minutes,
                            now,
                            sort_order
                        ],
                    )
                    .map_err(error_message)?;
                transaction
                    .execute(
                        "INSERT INTO external_todos(source, external_id, todo_id, last_synced_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![source, task.id, id, now],
                    )
                    .map_err(error_message)?;
                created += 1;
            } else {
                skipped += 1;
            }
        }

        transaction.commit().map_err(error_message)?;
        Ok(ZentaoSyncResult {
            created,
            updated,
            completed,
            skipped,
        })
    }

    pub fn diagnostics(&self) -> Result<DatabaseDiagnostics, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let schema_version = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(error_message)?;
        let (open_count, completed_count, archived_count, deleted_count) = connection
            .query_row(
                "SELECT
                    COALESCE(SUM(CASE WHEN status = 'open' AND deleted_at IS NULL THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'completed' AND deleted_at IS NULL THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'archived' AND deleted_at IS NULL THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0)
                 FROM todos",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(error_message)?;
        let reminder_delivery_count = connection
            .query_row("SELECT COUNT(*) FROM reminder_deliveries", [], |row| {
                row.get(0)
            })
            .map_err(error_message)?;
        Ok(DatabaseDiagnostics {
            schema_version,
            open_count,
            completed_count,
            archived_count,
            deleted_count,
            reminder_delivery_count,
        })
    }

    pub fn claim_due_reminders(&self, now: i64) -> Result<Vec<DueReminder>, String> {
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(error_message)?;
        let candidates = {
            let mut statement = transaction
                .prepare(
                    "SELECT t.id, t.title, t.deadline_at, t.reminder_minutes,
                            EXISTS(
                              SELECT 1 FROM reminder_deliveries d
                              WHERE d.todo_id = t.id AND d.deadline_at = t.deadline_at AND d.kind = 'upcoming'
                            ) AS upcoming_delivered,
                            EXISTS(
                              SELECT 1 FROM reminder_deliveries d
                              WHERE d.todo_id = t.id AND d.deadline_at = t.deadline_at AND d.kind = 'due'
                            ) AS due_delivered
                     FROM todos t
                     WHERE t.status = 'open' AND t.deleted_at IS NULL AND t.deadline_at IS NOT NULL",
                )
                .map_err(error_message)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, bool>(4)?,
                        row.get::<_, bool>(5)?,
                    ))
                })
                .map_err(error_message)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(error_message)?
        };

        let mut reminders = Vec::new();
        for (id, title, deadline_at, reminder_minutes, upcoming_delivered, due_delivered) in
            candidates
        {
            let Some(minutes) = reminder_minutes else {
                continue;
            };
            let (kind, fire_at) = if minutes == 0 {
                ("due", deadline_at)
            } else {
                (
                    "upcoming",
                    deadline_at.saturating_sub(minutes.saturating_mul(60_000)),
                )
            };
            let already_delivered = upcoming_delivered || due_delivered;

            if already_delivered || fire_at > now {
                continue;
            }

            transaction
                .execute(
                    "INSERT OR IGNORE INTO reminder_deliveries
                       (todo_id, deadline_at, kind, delivered_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![id, deadline_at, kind, now],
                )
                .map_err(error_message)?;

            if fire_at >= now.saturating_sub(MISSED_REMINDER_GRACE_MS) {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO reminder_inbox
                           (todo_id, deadline_at, kind, title, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![id, deadline_at, kind, title, now],
                    )
                    .map_err(error_message)?;
                reminders.push(DueReminder {
                    todo_id: id,
                    kind: kind.to_string(),
                    title,
                    deadline_at,
                });
            }
        }
        transaction
            .execute(
                "DELETE FROM reminder_inbox
                 WHERE rowid IN (
                   SELECT rowid FROM reminder_inbox
                   ORDER BY created_at DESC, rowid DESC
                   LIMIT -1 OFFSET ?1
                 )",
                [MAX_PENDING_REMINDERS],
            )
            .map_err(error_message)?;
        transaction.commit().map_err(error_message)?;
        Ok(reminders)
    }

    pub fn list_pending_reminders(&self) -> Result<Vec<DueReminder>, String> {
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(error_message)?;
        transaction
            .execute(
                "DELETE FROM reminder_inbox
                 WHERE NOT EXISTS (
                   SELECT 1 FROM todos t
                   WHERE t.id = reminder_inbox.todo_id
                     AND t.status = 'open'
                     AND t.deleted_at IS NULL
                     AND t.deadline_at = reminder_inbox.deadline_at
                 )",
                [],
            )
            .map_err(error_message)?;
        let reminders = {
            let mut statement = transaction
                .prepare(
                    "SELECT i.todo_id, i.kind, t.title, i.deadline_at
                     FROM reminder_inbox i
                     JOIN todos t ON t.id = i.todo_id
                     WHERE t.status = 'open'
                       AND t.deleted_at IS NULL
                       AND t.deadline_at = i.deadline_at
                     ORDER BY i.created_at ASC, i.rowid ASC",
                )
                .map_err(error_message)?;
            statement
                .query_map([], |row| {
                    Ok(DueReminder {
                        todo_id: row.get(0)?,
                        kind: row.get(1)?,
                        title: row.get(2)?,
                        deadline_at: row.get(3)?,
                    })
                })
                .map_err(error_message)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(error_message)?
        };
        transaction.commit().map_err(error_message)?;
        Ok(reminders)
    }

    pub fn acknowledge_pending_reminders(
        &self,
        reminders: &[ReminderAcknowledgement],
    ) -> Result<usize, String> {
        if reminders.len() > MAX_PENDING_REMINDERS as usize {
            return Err("一次最多确认 100 条提醒".to_string());
        }
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(error_message)?;
        let mut removed = 0;
        for reminder in reminders {
            validate_id(&reminder.todo_id)?;
            if !matches!(reminder.kind.as_str(), "upcoming" | "due") {
                return Err("提醒类型无效".to_string());
            }
            removed += transaction
                .execute(
                    "DELETE FROM reminder_inbox
                     WHERE todo_id = ?1 AND deadline_at = ?2 AND kind = ?3",
                    params![reminder.todo_id, reminder.deadline_at, reminder.kind],
                )
                .map_err(error_message)?;
        }
        transaction.commit().map_err(error_message)?;
        Ok(removed)
    }

    pub fn next_reminder_at(&self, _now: i64) -> Result<Option<i64>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT t.deadline_at, t.reminder_minutes,
                        EXISTS(
                          SELECT 1 FROM reminder_deliveries d
                          WHERE d.todo_id = t.id AND d.deadline_at = t.deadline_at AND d.kind = 'upcoming'
                        ) AS upcoming_delivered,
                        EXISTS(
                          SELECT 1 FROM reminder_deliveries d
                          WHERE d.todo_id = t.id AND d.deadline_at = t.deadline_at AND d.kind = 'due'
                        ) AS due_delivered
                 FROM todos t
                 WHERE t.status = 'open' AND t.deleted_at IS NULL AND t.deadline_at IS NOT NULL",
            )
            .map_err(error_message)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            })
            .map_err(error_message)?;

        let mut next: Option<i64> = None;
        for row in rows {
            let (deadline_at, reminder_minutes, upcoming_delivered, due_delivered) =
                row.map_err(error_message)?;
            let Some(minutes) = reminder_minutes else {
                continue;
            };
            if upcoming_delivered || due_delivered {
                continue;
            }
            let fire_at = if minutes == 0 {
                deadline_at
            } else {
                deadline_at.saturating_sub(minutes.saturating_mul(60_000))
            };
            next = Some(next.map_or(fire_at, |value| value.min(fire_at)));
        }
        Ok(next)
    }

    pub fn load_settings(&self) -> Result<AppSettings, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let value = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'app_settings'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(error_message)?;
        match value {
            Some(value) => serde_json::from_str(&value).map_err(|error| {
                log::error!("stored app settings are invalid: {error}");
                "本地设置格式无效".to_string()
            }),
            None => Ok(AppSettings::default()),
        }
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        validate_settings(settings)?;
        let value = serde_json::to_string(settings).map_err(|error| {
            log::error!("failed to serialize app settings: {error}");
            "无法保存本地设置".to_string()
        })?;
        let now = chrono::Utc::now().timestamp_millis();
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute(
                "INSERT INTO settings(key, value, updated_at)
                 VALUES ('app_settings', ?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![value, now],
            )
            .map_err(error_message)?;
        Ok(())
    }

    pub fn quiet_until(&self, now: i64) -> Result<Option<i64>, String> {
        let settings = self.load_settings()?;
        let (Some(start), Some(end)) = (
            settings.quiet_hours_start.as_deref(),
            settings.quiet_hours_end.as_deref(),
        ) else {
            return Ok(None);
        };
        let start = parse_clock_minutes(start)?;
        let end = parse_clock_minutes(end)?;
        let now_local = Local
            .timestamp_millis_opt(now)
            .single()
            .ok_or_else(|| "无法按当前时区计算静默时段".to_string())?;
        let current = (now_local.hour() * 60 + now_local.minute()) as u16;
        let Some(day_offset) = quiet_end_day_offset(current, start, end) else {
            return Ok(None);
        };
        let end_date = now_local
            .date_naive()
            .checked_add_days(chrono::Days::new(day_offset))
            .ok_or_else(|| "无法计算静默时段结束时间".to_string())?;
        let naive = end_date
            .and_hms_opt((end / 60) as u32, (end % 60) as u32, 0)
            .ok_or_else(|| "静默时段结束时间无效".to_string())?;
        let local_end =
            resolve_local_datetime(naive, |candidate| Local.from_local_datetime(&candidate))
                .ok_or_else(|| "当前时区无法表示静默时段结束时间".to_string())?;
        Ok(Some(local_end.timestamp_millis()))
    }

    pub fn export_bundle(&self, app_version: &str) -> Result<ExportBundle, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT id, title, body, status, priority, deadline_at, reminder_minutes,
                        completed_at, archived_at, created_at, updated_at, sort_order
                 FROM todos WHERE deleted_at IS NULL ORDER BY created_at ASC",
            )
            .map_err(error_message)?;
        let todos = statement
            .query_map([], todo_from_row)
            .map_err(error_message)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_message)?;
        let settings_value = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'app_settings'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(error_message)?;
        let settings = settings_value
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|error| {
                log::error!("stored app settings are invalid during export: {error}");
                "本地设置格式无效".to_string()
            })?
            .unwrap_or_default();

        Ok(ExportBundle {
            format_version: 1,
            exported_at: chrono::Utc::now().timestamp_millis(),
            app_version: app_version.to_string(),
            todos,
            settings,
        })
    }

    pub fn preview_import(&self, bundle: &ExportBundle) -> Result<ImportPreview, String> {
        validate_bundle_todos(bundle)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        preview_import_with_connection(&connection, bundle)
    }

    fn preview_import_in_transaction(
        transaction: &rusqlite::Transaction<'_>,
        bundle: &ExportBundle,
    ) -> Result<ImportPreview, String> {
        preview_import_with_connection(transaction, bundle)
    }

    pub fn preview_restore(&self, bundle: &ExportBundle) -> Result<RestorePreview, String> {
        validate_export_bundle(bundle)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        preview_restore_with_connection(&connection, bundle)
    }

    fn preview_restore_in_transaction(
        transaction: &rusqlite::Transaction<'_>,
        bundle: &ExportBundle,
    ) -> Result<RestorePreview, String> {
        preview_restore_with_connection(transaction, bundle)
    }

    pub fn import_bundle(&self, bundle: &ExportBundle) -> Result<ImportPreview, String> {
        validate_bundle_todos(bundle)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(error_message)?;
        let preview = Self::preview_import_in_transaction(&transaction, bundle)?;
        for todo in &bundle.todos {
            transaction
                .execute(
                    "INSERT INTO todos (
                       id, title, body, status, priority, deadline_at, reminder_minutes,
                       completed_at, archived_at, deleted_at, created_at, updated_at, sort_order
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12)
                     ON CONFLICT(id) DO UPDATE SET
                       title = excluded.title,
                       body = excluded.body,
                       status = excluded.status,
                       priority = excluded.priority,
                       deadline_at = excluded.deadline_at,
                       reminder_minutes = excluded.reminder_minutes,
                       completed_at = excluded.completed_at,
                       archived_at = excluded.archived_at,
                       deleted_at = NULL,
                       created_at = excluded.created_at,
                       updated_at = excluded.updated_at,
                       sort_order = excluded.sort_order
                     WHERE excluded.updated_at >= todos.updated_at",
                    params![
                        todo.id,
                        todo.title,
                        todo.body,
                        todo.status,
                        todo.priority,
                        todo.deadline_at,
                        todo.reminder_minutes,
                        todo.completed_at,
                        todo.archived_at,
                        todo.created_at,
                        todo.updated_at,
                        todo.sort_order,
                    ],
                )
                .map_err(error_message)?;
        }
        transaction.commit().map_err(error_message)?;
        Ok(preview)
    }

    pub fn restore_bundle(&self, bundle: &ExportBundle) -> Result<RestorePreview, String> {
        validate_export_bundle(bundle)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(error_message)?;
        let preview = Self::preview_restore_in_transaction(&transaction, bundle)?;
        transaction
            .execute("DELETE FROM reminder_inbox", [])
            .map_err(error_message)?;
        transaction
            .execute("DELETE FROM reminder_deliveries", [])
            .map_err(error_message)?;
        transaction
            .execute("DELETE FROM todos", [])
            .map_err(error_message)?;
        for todo in &bundle.todos {
            transaction
                .execute(
                    "INSERT INTO todos (
                       id, title, body, status, priority, deadline_at, reminder_minutes,
                       completed_at, archived_at, deleted_at, created_at, updated_at, sort_order
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12)",
                    params![
                        todo.id,
                        todo.title,
                        todo.body,
                        todo.status,
                        todo.priority,
                        todo.deadline_at,
                        todo.reminder_minutes,
                        todo.completed_at,
                        todo.archived_at,
                        todo.created_at,
                        todo.updated_at,
                        todo.sort_order,
                    ],
                )
                .map_err(error_message)?;
        }
        let settings_json = serde_json::to_string(&bundle.settings).map_err(|error| {
            log::error!("failed to serialize restored settings: {error}");
            "备份设置无效".to_string()
        })?;
        transaction
            .execute(
                "INSERT INTO settings(key, value, updated_at)
                 VALUES ('app_settings', ?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![settings_json, chrono::Utc::now().timestamp_millis()],
            )
            .map_err(error_message)?;
        transaction.commit().map_err(error_message)?;
        Ok(preview)
    }
}

fn preview_import_with_connection(
    connection: &Connection,
    bundle: &ExportBundle,
) -> Result<ImportPreview, String> {
    let mut new_count = 0;
    let mut update_count = 0;
    let mut statement = connection
        .prepare("SELECT updated_at FROM todos WHERE id = ?1")
        .map_err(error_message)?;
    for todo in &bundle.todos {
        let existing = statement
            .query_row([&todo.id], |row| row.get::<_, i64>(0))
            .optional()
            .map_err(error_message)?;
        match existing {
            None => new_count += 1,
            Some(updated_at) if todo.updated_at >= updated_at => update_count += 1,
            Some(_) => {}
        }
    }
    Ok(ImportPreview {
        total: bundle.todos.len(),
        new_count,
        update_count,
    })
}

fn preview_restore_with_connection(
    connection: &Connection,
    bundle: &ExportBundle,
) -> Result<RestorePreview, String> {
    let mut statement = connection
        .prepare("SELECT id FROM todos WHERE deleted_at IS NULL")
        .map_err(error_message)?;
    let current = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(error_message)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(error_message)?;
    let incoming = bundle
        .todos
        .iter()
        .map(|todo| todo.id.as_str())
        .collect::<HashSet<_>>();
    let add_count = incoming.iter().filter(|id| !current.contains(**id)).count();
    let replace_count = incoming.iter().filter(|id| current.contains(**id)).count();
    let remove_count = current
        .iter()
        .filter(|id| !incoming.contains(id.as_str()))
        .count();
    Ok(RestorePreview {
        total: bundle.todos.len(),
        add_count,
        replace_count,
        remove_count,
    })
}

fn migrate(connection: &Connection) -> Result<(), String> {
    let version = schema_version(connection)?;

    if version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "本地数据库版本 {version} 高于当前应用支持的版本 {CURRENT_SCHEMA_VERSION}；请使用更新版本的 TodoDock"
        ));
    }

    if version < 1 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS todos (
                    id TEXT PRIMARY KEY NOT NULL,
                    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
                    body TEXT NOT NULL DEFAULT '' CHECK(length(body) <= 100000),
                    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'completed', 'archived')),
                    priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3),
                    deadline_at INTEGER,
                    reminder_minutes INTEGER CHECK(reminder_minutes IS NULL OR reminder_minutes BETWEEN 0 AND 525600),
                    completed_at INTEGER,
                    archived_at INTEGER,
                    deleted_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    sort_order REAL NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_todos_status_deadline
                    ON todos(status, deadline_at) WHERE deleted_at IS NULL;
                 CREATE INDEX IF NOT EXISTS idx_todos_sort
                    ON todos(status, sort_order) WHERE deleted_at IS NULL;
                 CREATE TABLE IF NOT EXISTS reminder_deliveries (
                    todo_id TEXT NOT NULL,
                    deadline_at INTEGER NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('upcoming', 'due')),
                    delivered_at INTEGER NOT NULL,
                    PRIMARY KEY(todo_id, deadline_at, kind),
                    FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE
                 );
                 CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(error_message)?;
    }

    if version < 2 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS reminder_inbox (
                    todo_id TEXT NOT NULL,
                    deadline_at INTEGER NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('upcoming', 'due')),
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(todo_id, deadline_at, kind),
                    FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_reminder_inbox_created
                    ON reminder_inbox(created_at);
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(error_message)?;
    }

    if version < 3 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS external_todos (
                    source TEXT NOT NULL,
                    external_id TEXT NOT NULL,
                    todo_id TEXT NOT NULL UNIQUE,
                    last_synced_at INTEGER NOT NULL,
                    PRIMARY KEY(source, external_id),
                    FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE
                 );
                 PRAGMA user_version = 3;
                 COMMIT;",
            )
            .map_err(error_message)?;
        migrate_legacy_boss_key(connection)?;
    }

    if version < 4 {
        migrate_ime_conflicting_create_shortcut(connection)?;
        connection
            .pragma_update(None, "user_version", 4)
            .map_err(error_message)?;
    }

    Ok(())
}

fn migrate_legacy_boss_key(connection: &Connection) -> Result<(), String> {
    let value = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'app_settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error_message)?;
    let Some(value) = value else {
        return Ok(());
    };
    let mut settings: AppSettings = serde_json::from_str(&value).map_err(|error| {
        log::error!("cannot migrate stored shortcut: {error}");
        "本地设置格式无效".to_string()
    })?;
    if settings.global_shortcut == "CommandOrControl+Shift+Space" {
        settings.global_shortcut = "Alt+Space".to_string();
        let encoded = serde_json::to_string(&settings).map_err(|error| {
            log::error!("cannot encode migrated shortcut: {error}");
            "无法迁移老板键设置".to_string()
        })?;
        connection
            .execute(
                "UPDATE settings SET value = ?1 WHERE key = 'app_settings'",
                [encoded],
            )
            .map_err(error_message)?;
    }
    Ok(())
}

fn is_ime_conflicting_create_shortcut(shortcut: &str) -> bool {
    matches!(
        shortcut,
        "Control+Space" | "Ctrl+Space" | "CommandOrControl+Space" | "CommandOrCtrl+Space"
    )
}

fn migrate_ime_conflicting_create_shortcut(connection: &Connection) -> Result<(), String> {
    let value = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'app_settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error_message)?;
    let Some(value) = value else {
        return Ok(());
    };
    let mut settings: AppSettings = serde_json::from_str(&value).map_err(|error| {
        log::error!("cannot migrate stored create shortcut: {error}");
        "本地设置格式无效".to_string()
    })?;
    if !is_ime_conflicting_create_shortcut(&settings.create_shortcut) {
        return Ok(());
    }
    settings.create_shortcut = "Control+Alt+KeyQ".to_string();
    let encoded = serde_json::to_string(&settings).map_err(|error| {
        log::error!("cannot encode migrated create shortcut: {error}");
        "无法迁移新建快捷键设置".to_string()
    })?;
    connection
        .execute(
            "UPDATE settings SET value = ?1 WHERE key = 'app_settings'",
            [encoded],
        )
        .map_err(error_message)?;
    Ok(())
}

fn schema_version(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(error_message)
}

fn backup_before_migration(
    connection: &Connection,
    database_path: &Path,
    version: i64,
) -> Result<(), String> {
    let parent = database_path
        .parent()
        .ok_or_else(|| "无法确定数据库迁移备份目录".to_string())?;
    let directory = parent.join("backups");
    std::fs::create_dir_all(&directory).map_err(|error| {
        log::error!("failed to create migration backup directory: {error}");
        "无法创建数据库迁移备份目录".to_string()
    })?;
    let suffix = format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f"),
        Uuid::now_v7()
    );
    let path = directory.join(format!("tododock-pre-migration-v{version}-{suffix}.db"));
    connection
        .backup(rusqlite::MAIN_DB, &path, None)
        .map_err(|error| {
            log::error!("database pre-migration backup failed: {error}");
            "升级本地数据库前无法创建一致性备份".to_string()
        })?;
    Ok(())
}

fn query_todo(connection: &Connection, id: &str) -> Result<Option<Todo>, String> {
    connection
        .query_row(
            "SELECT id, title, body, status, priority, deadline_at, reminder_minutes,
                    completed_at, archived_at, created_at, updated_at, sort_order
             FROM todos WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            todo_from_row,
        )
        .optional()
        .map_err(error_message)
}

fn todo_from_row(row: &Row<'_>) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        status: row.get(3)?,
        priority: row.get(4)?,
        deadline_at: row.get(5)?,
        reminder_minutes: row.get(6)?,
        completed_at: row.get(7)?,
        archived_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        sort_order: row.get(11)?,
    })
}

fn validate_filter(filter: &str) -> Result<(), String> {
    match filter {
        "open" | "today" | "completed" | "archived" => Ok(()),
        _ => Err("未知 Todo 筛选条件".to_string()),
    }
}

fn validate_todo_input(
    title: &str,
    body: &str,
    priority: i64,
    deadline_at: Option<i64>,
    reminder_minutes: Option<i64>,
) -> Result<(), String> {
    let title_length = title.trim().chars().count();
    if !(1..=240).contains(&title_length) {
        return Err("Todo 标题长度必须为 1–240 个字符".to_string());
    }
    if body.chars().count() > 100_000 {
        return Err("Todo Markdown 正文不能超过 100000 个字符".to_string());
    }
    if !(0..=3).contains(&priority) {
        return Err("Todo 优先级无效".to_string());
    }
    if let Some(deadline) = deadline_at {
        if !(-2_208_988_800_000..=32_503_680_000_000).contains(&deadline) {
            return Err("Todo 截止时间超出支持范围".to_string());
        }
    }
    if let Some(minutes) = reminder_minutes {
        if deadline_at.is_none() {
            return Err("没有截止时间时不能设置提醒".to_string());
        }
        if !(0..=525_600).contains(&minutes) {
            return Err("提醒提前量超出支持范围".to_string());
        }
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), String> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "Todo ID 无效".to_string())
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    if !matches!(settings.theme.as_str(), "system" | "light" | "dark") {
        return Err("主题设置无效".to_string());
    }
    validate_shortcut(&settings.global_shortcut)?;
    validate_shortcut(&settings.create_shortcut)?;
    if settings
        .global_shortcut
        .eq_ignore_ascii_case(settings.create_shortcut.trim())
    {
        return Err("新建待办和待办窗口快捷键不能相同".to_string());
    }
    validate_zentao_settings(settings)?;
    if !(0..=525_600).contains(&settings.default_reminder_minutes) {
        return Err("默认提醒提前量无效".to_string());
    }
    for value in [
        settings.quiet_hours_start.as_deref(),
        settings.quiet_hours_end.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let (hours, minutes) = value
            .split_once(':')
            .ok_or_else(|| "静默时段格式必须为 HH:MM".to_string())?;
        let hours: u8 = hours.parse().map_err(|_| "静默时段小时无效".to_string())?;
        let minutes: u8 = minutes
            .parse()
            .map_err(|_| "静默时段分钟无效".to_string())?;
        if hours > 23 || minutes > 59 {
            return Err("静默时段超出有效范围".to_string());
        }
    }
    if settings.quiet_hours_start.is_some() != settings.quiet_hours_end.is_some() {
        return Err("静默时段必须同时设置开始和结束时间".to_string());
    }
    if settings.quiet_hours_start == settings.quiet_hours_end
        && settings.quiet_hours_start.is_some()
    {
        return Err("静默时段开始和结束时间不能相同".to_string());
    }
    Ok(())
}

fn validate_shortcut(shortcut: &str) -> Result<(), String> {
    let shortcut = shortcut.trim();
    if shortcut.len() > 80 {
        return Err("全局快捷键过长".to_string());
    }
    let mut parts: Vec<&str> = shortcut.split('+').collect();
    if parts.len() < 2 {
        return Err("老板键需要包含修饰键和主键，例如 Alt+Space".to_string());
    }
    let key = parts.pop().unwrap_or_default();
    const MODIFIERS: [&str; 8] = [
        "Alt",
        "Control",
        "Shift",
        "Super",
        "Command",
        "CommandOrControl",
        "Meta",
        "Option",
    ];
    if key.is_empty()
        || parts.is_empty()
        || parts.iter().any(|part| {
            !MODIFIERS
                .iter()
                .any(|modifier| modifier.eq_ignore_ascii_case(part))
        })
    {
        return Err("全局快捷键格式无效".to_string());
    }
    Ok(())
}

fn validate_zentao_settings(settings: &AppSettings) -> Result<(), String> {
    let url = settings.zentao_url.trim();
    let account = settings.zentao_account.trim();
    if url.is_empty() && account.is_empty() && settings.zentao_password.is_empty() {
        return Ok(());
    }
    crate::zentao::normalize_base(&settings.zentao_url)?;
    if account.is_empty() || account.chars().count() > 64 {
        return Err("禅道账号无效".to_string());
    }
    if settings.zentao_password.is_empty() || settings.zentao_password.len() > 200 {
        return Err("禅道密码无效".to_string());
    }
    Ok(())
}

fn validate_bundle_todos(bundle: &ExportBundle) -> Result<(), String> {
    if bundle.format_version != 1 {
        return Err(format!("不支持的数据格式版本：{}", bundle.format_version));
    }
    if bundle.todos.len() > 100_000 {
        return Err("导入文件包含过多 Todo".to_string());
    }
    let mut ids = HashSet::with_capacity(bundle.todos.len());
    for todo in &bundle.todos {
        validate_id(&todo.id)?;
        if !ids.insert(&todo.id) {
            return Err("导入文件包含重复 Todo ID".to_string());
        }
        validate_todo_input(
            &todo.title,
            &todo.body,
            todo.priority,
            todo.deadline_at,
            todo.reminder_minutes,
        )?;
        if !matches!(todo.status.as_str(), "open" | "completed" | "archived") {
            return Err("导入文件包含无效 Todo 状态".to_string());
        }
        if !todo.sort_order.is_finite() {
            return Err("导入文件包含无效排序值".to_string());
        }
        for timestamp in [
            Some(todo.created_at),
            Some(todo.updated_at),
            todo.completed_at,
            todo.archived_at,
        ]
        .into_iter()
        .flatten()
        {
            if !(-2_208_988_800_000..=32_503_680_000_000).contains(&timestamp) {
                return Err("导入文件包含超出支持范围的时间".to_string());
            }
        }
        if todo.status == "completed" && todo.completed_at.is_none() {
            return Err("已完成 Todo 缺少完成时间".to_string());
        }
        if todo.status != "completed" && todo.completed_at.is_some() {
            return Err("未完成 Todo 不应包含完成时间".to_string());
        }
        if todo.status == "archived" && todo.archived_at.is_none() {
            return Err("已归档 Todo 缺少归档时间".to_string());
        }
        if todo.status != "archived" && todo.archived_at.is_some() {
            return Err("未归档 Todo 不应包含归档时间".to_string());
        }
        if todo.updated_at < todo.created_at {
            return Err("导入文件包含倒退的更新时间".to_string());
        }
    }
    Ok(())
}

fn validate_export_bundle(bundle: &ExportBundle) -> Result<(), String> {
    validate_bundle_todos(bundle)?;
    validate_settings(&bundle.settings)
}

fn parse_clock_minutes(value: &str) -> Result<u16, String> {
    let (hours, minutes) = value
        .split_once(':')
        .ok_or_else(|| "静默时段格式必须为 HH:MM".to_string())?;
    let hours: u16 = hours.parse().map_err(|_| "静默时段小时无效".to_string())?;
    let minutes: u16 = minutes
        .parse()
        .map_err(|_| "静默时段分钟无效".to_string())?;
    if hours > 23 || minutes > 59 {
        return Err("静默时段超出有效范围".to_string());
    }
    Ok(hours * 60 + minutes)
}

fn quiet_end_day_offset(current: u16, start: u16, end: u16) -> Option<u64> {
    if start < end {
        (current >= start && current < end).then_some(0)
    } else if current >= start {
        Some(1)
    } else if current < end {
        Some(0)
    } else {
        None
    }
}

fn resolve_local_datetime<T>(
    naive: chrono::NaiveDateTime,
    mut resolve: impl FnMut(chrono::NaiveDateTime) -> chrono::LocalResult<T>,
) -> Option<T> {
    for minute_offset in 0..=24 * 60 {
        let candidate = naive.checked_add_signed(chrono::Duration::minutes(minute_offset))?;
        if let Some(resolved) = resolve(candidate).latest() {
            return Some(resolved);
        }
    }
    None
}

fn end_of_local_day_millis() -> Result<i64, String> {
    let tomorrow = Local::now()
        .date_naive()
        .succ_opt()
        .ok_or_else(|| "无法计算今天的结束时间".to_string())?;
    let midnight = tomorrow
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "无法计算今天的结束时间".to_string())?;
    let local = Local
        .from_local_datetime(&midnight)
        .earliest()
        .ok_or_else(|| "当前时区无法表示明天零点".to_string())?;
    Ok(local.timestamp_millis() - 1)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn error_message(error: rusqlite::Error) -> String {
    log::error!("database operation failed: {error}");
    "本地数据库操作失败".to_string()
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    log::error!("database lock poisoned");
    "本地数据库暂时不可用".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input() -> CreateTodoInput {
        CreateTodoInput {
            title: "Ship the first build".to_string(),
            body: "- [ ] run tests".to_string(),
            priority: 2,
            deadline_at: Some(1_900_000_000_000),
            reminder_minutes: Some(15),
        }
    }

    fn insert_performance_todos(
        database: &Database,
        deadline_at: Option<i64>,
        reminder_minutes: Option<i64>,
    ) {
        let mut connection = database.connection.lock().expect("database lock");
        let transaction = connection.transaction().expect("transaction");
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO todos (
                       id, title, body, status, priority, deadline_at, reminder_minutes,
                       created_at, updated_at, sort_order
                     ) VALUES (?1, ?2, '', 'open', 0, ?3, ?4, ?5, ?5, ?6)",
                )
                .expect("prepare insert");
            for index in 0..10_000 {
                let title = if index % 97 == 0 {
                    format!("needle task {index}")
                } else {
                    format!("ordinary task {index}")
                };
                statement
                    .execute(params![
                        Uuid::now_v7().to_string(),
                        title,
                        deadline_at,
                        reminder_minutes,
                        1_900_000_000_000_i64,
                        index as f64
                    ])
                    .expect("insert todo");
            }
        }
        transaction.commit().expect("commit fixture");
    }

    #[test]
    fn creates_lists_completes_and_soft_deletes_a_todo() {
        let database = Database::open_in_memory().expect("open database");
        let created = database.create_todo(&sample_input()).expect("create todo");
        assert_eq!(created.title, "Ship the first build");
        assert_eq!(created.status, "open");
        assert_eq!(
            database.get_todo(&created.id).expect("get todo").title,
            created.title
        );
        assert_eq!(
            database
                .get_todo("01991a3b-e122-7fd0-a321-f4af72160cb8")
                .unwrap_err(),
            "Todo 不存在或已被删除"
        );

        let open = database
            .list_todos(&ListTodosInput {
                filter: "open".to_string(),
                search: "first".to_string(),
            })
            .expect("list todos");
        assert_eq!(open.len(), 1);

        let completed = database
            .set_completed(&created.id, true)
            .expect("complete todo");
        assert_eq!(completed.status, "completed");
        assert!(completed.completed_at.is_some());

        database.soft_delete(&created.id).expect("soft delete");
        let completed = database
            .list_todos(&ListTodosInput {
                filter: "completed".to_string(),
                search: String::new(),
            })
            .expect("list completed");
        assert!(completed.is_empty());

        let restored = database
            .restore_deleted(&created.id)
            .expect("restore deleted todo");
        assert_eq!(restored.status, "completed");
        let completed = database
            .list_todos(&ListTodosInput {
                filter: "completed".to_string(),
                search: String::new(),
            })
            .expect("list restored todo");
        assert_eq!(completed.len(), 1);
    }

    #[test]
    fn archives_restores_reorders_and_purges_todos() {
        let database = Database::open_in_memory().expect("open database");
        let mut first_input = sample_input();
        first_input.title = "First".to_string();
        let first = database.create_todo(&first_input).expect("create first");
        let mut second_input = sample_input();
        second_input.title = "Second".to_string();
        let second = database.create_todo(&second_input).expect("create second");

        database
            .reorder_todos(&[second.id.clone(), first.id.clone()])
            .expect("reorder todos");
        let open = database
            .list_todos(&ListTodosInput {
                filter: "open".to_string(),
                search: String::new(),
            })
            .expect("list reordered todos");
        assert_eq!(
            open.iter()
                .map(|todo| todo.title.as_str())
                .collect::<Vec<_>>(),
            ["Second", "First"]
        );
        assert!(
            database
                .reorder_todos(&[first.id.clone(), first.id.clone()])
                .is_err()
        );

        let archived = database
            .set_archived(&first.id, true)
            .expect("archive todo");
        assert_eq!(archived.status, "archived");
        assert!(archived.archived_at.is_some());
        let archived_list = database
            .list_todos(&ListTodosInput {
                filter: "archived".to_string(),
                search: String::new(),
            })
            .expect("list archived todos");
        assert_eq!(archived_list.len(), 1);
        let reminders = database
            .claim_due_reminders(1_900_000_000_000)
            .expect("claim archived reminders");
        assert!(
            reminders
                .iter()
                .all(|reminder| reminder.todo_id != first.id)
        );

        let restored = database
            .set_archived(&first.id, false)
            .expect("restore archived todo");
        assert_eq!(restored.status, "open");
        assert!(restored.archived_at.is_none());

        database.soft_delete(&first.id).expect("soft delete");
        assert_eq!(database.purge_deleted().expect("purge deleted"), 1);
        assert!(database.restore_deleted(&first.id).is_err());
    }

    #[test]
    fn diagnostics_only_expose_aggregate_database_state() {
        let database = Database::open_in_memory().expect("open database");
        let mut input = sample_input();
        input.title = "private title must not leave database".to_string();
        input.body = "private body must not leave database".to_string();
        let todo = database.create_todo(&input).expect("create todo");
        database.soft_delete(&todo.id).expect("soft delete");

        assert_eq!(
            database.diagnostics().expect("collect diagnostics"),
            DatabaseDiagnostics {
                schema_version: CURRENT_SCHEMA_VERSION,
                open_count: 0,
                completed_count: 0,
                archived_count: 0,
                deleted_count: 1,
                reminder_delivery_count: 0,
            }
        );
    }

    #[test]
    fn rejects_a_database_created_by_a_newer_schema() {
        let connection = Connection::open_in_memory().expect("open database");
        connection
            .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
            .expect("set future schema version");
        let error = Database::from_connection(connection)
            .err()
            .expect("reject future schema");
        assert!(error.contains("高于当前应用支持的版本"));
    }

    #[test]
    fn creates_a_consistent_backup_before_migrating_an_existing_database() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("tododock.db");
        {
            let connection = Connection::open(&path).expect("create legacy database");
            connection
                .execute_batch(
                    "CREATE TABLE legacy_marker(value TEXT NOT NULL);
                     INSERT INTO legacy_marker(value) VALUES ('preserved');",
                )
                .expect("write legacy data");
        }

        let database = Database::open(&path).expect("migrate database");
        assert_eq!(
            schema_version(&database.connection.lock().expect("lock database"))
                .expect("read schema version"),
            CURRENT_SCHEMA_VERSION
        );

        let backups = std::fs::read_dir(directory.path().join("backups"))
            .expect("read migration backups")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect migration backups");
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(backups[0].path()).expect("open migration backup");
        let value: String = backup
            .query_row("SELECT value FROM legacy_marker", [], |row| row.get(0))
            .expect("read preserved legacy data");
        assert_eq!(value, "preserved");
        assert_eq!(schema_version(&backup).expect("read backup version"), 0);
    }

    #[test]
    fn reopening_rolls_back_an_uncommitted_database_transaction() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("tododock.db");
        let todo_id = {
            let database = Database::open(&path).expect("open database");
            let todo = database.create_todo(&sample_input()).expect("create todo");
            let connection = database.connection.lock().expect("lock database");
            connection
                .execute_batch("BEGIN IMMEDIATE")
                .expect("start uncommitted transaction");
            connection
                .execute(
                    "UPDATE todos SET title = 'not committed' WHERE id = ?1",
                    [&todo.id],
                )
                .expect("write uncommitted change");
            drop(connection);
            todo.id
        };

        let reopened = Database::open(&path).expect("reopen database");
        let todo = query_todo(
            &reopened.connection.lock().expect("lock reopened database"),
            &todo_id,
        )
        .expect("query todo")
        .expect("todo remains");
        assert_eq!(todo.title, "Ship the first build");
    }

    #[test]
    fn migrates_v1_to_the_durable_reminder_inbox() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("tododock.db");
        drop(Database::open(&path).expect("create current database"));
        {
            let connection = Connection::open(&path).expect("open database as v1");
            connection
                .execute_batch("DROP TABLE reminder_inbox; PRAGMA user_version = 1;")
                .expect("downgrade schema marker");
        }

        let database = Database::open(&path).expect("migrate v1 database");
        let connection = database.connection.lock().expect("lock database");
        assert_eq!(
            schema_version(&connection).expect("read migrated version"),
            CURRENT_SCHEMA_VERSION
        );
        let inbox_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reminder_inbox')",
                [],
                |row| row.get(0),
            )
            .expect("check reminder inbox table");
        assert!(inbox_exists);
    }

    #[test]
    fn pending_reminders_survive_reopening_until_acknowledged() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("tododock.db");
        let now = 1_900_000_000_000;
        let todo_id = {
            let database = Database::open(&path).expect("open database");
            let mut input = sample_input();
            input.deadline_at = Some(now);
            input.reminder_minutes = Some(0);
            let todo = database.create_todo(&input).expect("create todo");
            assert_eq!(
                database
                    .claim_due_reminders(now)
                    .expect("claim reminder")
                    .len(),
                1
            );
            todo.id
        };

        let reopened = Database::open(&path).expect("reopen database");
        let pending = reopened
            .list_pending_reminders()
            .expect("list pending reminders");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].todo_id, todo_id);
        assert_eq!(
            reopened
                .list_pending_reminders()
                .expect("list reminders again"),
            pending
        );
        let acknowledgement = ReminderAcknowledgement {
            todo_id: pending[0].todo_id.clone(),
            kind: pending[0].kind.clone(),
            deadline_at: pending[0].deadline_at,
        };
        assert_eq!(
            reopened
                .acknowledge_pending_reminders(&[acknowledgement])
                .expect("acknowledge reminder"),
            1
        );
        assert!(
            reopened
                .list_pending_reminders()
                .expect("list acknowledged inbox")
                .is_empty()
        );
        assert!(
            reopened
                .claim_due_reminders(now)
                .expect("do not redeliver reminder")
                .is_empty()
        );
    }

    #[test]
    fn durable_reminder_inbox_keeps_only_the_newest_hundred_items() {
        let database = Database::open_in_memory().expect("open database");
        let now = 1_900_000_000_000;
        for index in 0..105 {
            let mut input = sample_input();
            input.title = format!("Reminder {index}");
            input.deadline_at = Some(now);
            input.reminder_minutes = Some(0);
            database.create_todo(&input).expect("create todo");
        }

        assert_eq!(
            database
                .claim_due_reminders(now)
                .expect("claim reminders")
                .len(),
            105
        );
        assert_eq!(
            database
                .list_pending_reminders()
                .expect("list bounded inbox")
                .len(),
            MAX_PENDING_REMINDERS as usize
        );
    }

    #[test]
    fn pending_reminders_are_discarded_after_the_todo_is_completed() {
        let database = Database::open_in_memory().expect("open database");
        let now = 1_900_000_000_000;
        let mut input = sample_input();
        input.deadline_at = Some(now);
        input.reminder_minutes = Some(0);
        let todo = database.create_todo(&input).expect("create todo");
        database.claim_due_reminders(now).expect("claim reminder");
        database
            .set_completed(&todo.id, true)
            .expect("complete todo");

        assert!(
            database
                .list_pending_reminders()
                .expect("list pending reminders")
                .is_empty()
        );
        let pending_count: i64 = database
            .connection
            .lock()
            .expect("lock database")
            .query_row("SELECT COUNT(*) FROM reminder_inbox", [], |row| row.get(0))
            .expect("count pending reminders");
        assert_eq!(pending_count, 0);
    }

    #[test]
    fn pending_reminders_use_the_todos_latest_title() {
        let database = Database::open_in_memory().expect("open database");
        let now = 1_900_000_000_000;
        let mut input = sample_input();
        input.deadline_at = Some(now);
        input.reminder_minutes = Some(0);
        let todo = database.create_todo(&input).expect("create todo");
        database.claim_due_reminders(now).expect("claim reminder");
        database
            .update_todo(&UpdateTodoInput {
                id: todo.id,
                title: "Updated reminder title".to_string(),
                body: input.body,
                priority: input.priority,
                deadline_at: input.deadline_at,
                reminder_minutes: input.reminder_minutes,
            })
            .expect("update todo title");

        let pending = database
            .list_pending_reminders()
            .expect("list pending reminders");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].title, "Updated reminder title");
    }

    #[test]
    fn rejects_reminders_without_a_deadline() {
        let database = Database::open_in_memory().expect("open database");
        let mut input = sample_input();
        input.deadline_at = None;
        assert!(database.create_todo(&input).is_err());
    }

    #[test]
    fn treats_like_wildcards_as_literal_search_text() {
        let database = Database::open_in_memory().expect("open database");
        database.create_todo(&sample_input()).expect("create todo");
        let results = database
            .list_todos(&ListTodosInput {
                filter: "open".to_string(),
                search: "%".to_string(),
            })
            .expect("search todos");
        assert!(results.is_empty());
    }

    #[test]
    fn paginates_todo_lists_with_bounded_arguments() {
        let database = Database::open_in_memory().expect("open database");
        for title in ["One", "Two", "Three"] {
            let mut input = sample_input();
            input.title = title.to_string();
            database.create_todo(&input).expect("create todo");
        }
        let input = ListTodosInput {
            filter: "open".to_string(),
            search: String::new(),
        };
        let page = database
            .list_todos_page(&input, 2, 1)
            .expect("read second page");
        assert_eq!(
            page.iter()
                .map(|todo| todo.title.as_str())
                .collect::<Vec<_>>(),
            ["Two", "Three"]
        );
        assert!(database.list_todos_page(&input, 0, 0).is_err());
        assert!(database.list_todos_page(&input, 501, 0).is_err());
    }

    #[test]
    fn claims_each_configured_reminder_only_once() {
        let database = Database::open_in_memory().expect("open database");
        let now = 1_900_000_000_000;
        let mut input = sample_input();
        input.deadline_at = Some(now + 10 * 60_000);
        input.reminder_minutes = Some(15);
        let created = database.create_todo(&input).expect("create todo");

        let upcoming = database
            .claim_due_reminders(now)
            .expect("claim upcoming reminder");
        assert_eq!(upcoming.len(), 1);
        assert_eq!(upcoming[0].todo_id, created.id);
        assert_eq!(upcoming[0].kind, "upcoming");
        assert!(
            database
                .claim_due_reminders(now)
                .expect("deduplicate upcoming reminder")
                .is_empty()
        );
        assert!(
            database
                .claim_due_reminders(now + 10 * 60_000)
                .expect("do not emit a second reminder at the deadline")
                .is_empty()
        );
        assert_eq!(
            database
                .next_reminder_at(now + 10 * 60_000)
                .expect("next reminder"),
            None
        );
    }

    #[test]
    fn zero_minute_reminders_fire_at_the_deadline() {
        let database = Database::open_in_memory().expect("open database");
        let now = 1_900_000_000_000;
        let deadline = now + 10 * 60_000;
        let mut input = sample_input();
        input.deadline_at = Some(deadline);
        input.reminder_minutes = Some(0);
        database.create_todo(&input).expect("create todo");

        assert!(
            database
                .claim_due_reminders(now)
                .expect("claim before deadline")
                .is_empty()
        );
        assert_eq!(
            database.next_reminder_at(now).expect("next reminder"),
            Some(deadline)
        );
        let due = database
            .claim_due_reminders(deadline)
            .expect("claim due reminder");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].kind, "due");
        assert!(
            database
                .claim_due_reminders(deadline)
                .expect("deduplicate due reminder")
                .is_empty()
        );
    }

    #[test]
    fn changing_reminder_mode_does_not_duplicate_a_delivered_deadline() {
        let database = Database::open_in_memory().expect("open database");
        let now = 1_900_000_000_000;
        let mut input = sample_input();
        input.deadline_at = Some(now);
        input.reminder_minutes = Some(0);
        let created = database.create_todo(&input).expect("create todo");
        assert_eq!(
            database
                .claim_due_reminders(now)
                .expect("claim due reminder")
                .len(),
            1
        );

        database
            .update_todo(&UpdateTodoInput {
                id: created.id,
                title: input.title,
                body: input.body,
                priority: input.priority,
                deadline_at: input.deadline_at,
                reminder_minutes: Some(15),
            })
            .expect("change reminder mode");
        assert!(
            database
                .claim_due_reminders(now)
                .expect("avoid second delivery")
                .is_empty()
        );
    }

    #[test]
    fn changing_deadline_rearms_reminder_and_removes_old_inbox_entry() {
        let database = Database::open_in_memory().expect("open database");
        let now = 1_900_000_000_000;
        let mut input = sample_input();
        input.deadline_at = Some(now);
        input.reminder_minutes = Some(0);
        let created = database.create_todo(&input).expect("create todo");
        assert_eq!(
            database
                .claim_due_reminders(now)
                .expect("claim old reminder")
                .len(),
            1
        );

        let next_deadline = now + 10 * 60_000;
        database
            .update_todo(&UpdateTodoInput {
                id: created.id.clone(),
                title: input.title,
                body: input.body,
                priority: input.priority,
                deadline_at: Some(next_deadline),
                reminder_minutes: Some(0),
            })
            .expect("change deadline");
        assert!(
            database
                .list_pending_reminders()
                .expect("list old reminders")
                .is_empty()
        );
        assert_eq!(
            database
                .claim_due_reminders(next_deadline)
                .expect("claim new reminder")
                .iter()
                .filter(|reminder| reminder.todo_id == created.id)
                .count(),
            1
        );
    }

    #[test]
    fn completed_todos_do_not_emit_reminders() {
        let database = Database::open_in_memory().expect("open database");
        let now = 1_900_000_000_000;
        let mut input = sample_input();
        input.deadline_at = Some(now);
        let created = database.create_todo(&input).expect("create todo");
        database
            .set_completed(&created.id, true)
            .expect("complete todo");

        assert!(
            database
                .claim_due_reminders(now)
                .expect("claim reminders")
                .is_empty()
        );
    }

    #[test]
    fn opting_out_of_reminders_skips_both_upcoming_and_due_delivery() {
        let database = Database::open_in_memory().expect("open database");
        let now = 1_900_000_000_000;
        let mut input = sample_input();
        input.deadline_at = Some(now - 60_000);
        input.reminder_minutes = None;
        database.create_todo(&input).expect("create todo");

        assert!(
            database
                .claim_due_reminders(now)
                .expect("claim reminders")
                .is_empty()
        );
        assert_eq!(database.next_reminder_at(now).expect("next reminder"), None);
    }

    #[test]
    fn settings_round_trip_and_reject_invalid_values() {
        let database = Database::open_in_memory().expect("open database");
        let mut settings = database.load_settings().expect("load defaults");
        assert_eq!(settings, AppSettings::default());
        assert!(settings.global_shortcut_enabled);
        assert_eq!(settings.global_shortcut, "Alt+Space");
        assert_eq!(settings.create_shortcut, "Control+Alt+KeyQ");
        settings.theme = "dark".to_string();
        settings.global_shortcut = "CommandOrControl+Alt+T".to_string();
        database.save_settings(&settings).expect("save settings");
        assert_eq!(database.load_settings().expect("reload settings"), settings);

        settings.theme = "dark".to_string();
        settings.global_shortcut = "Space".to_string();
        assert!(database.save_settings(&settings).is_err());
        settings.global_shortcut = "Alt+Space".to_string();
        settings.create_shortcut = "Alt+Space".to_string();
        assert!(database.save_settings(&settings).is_err());
        settings.create_shortcut = "Control+Alt+KeyQ".to_string();
        settings.theme = "neon".to_string();
        assert!(database.save_settings(&settings).is_err());

        let legacy: AppSettings =
            serde_json::from_str(r#"{"theme":"dark","globalShortcut":"CommandOrControl+Alt+T"}"#)
                .expect("decode legacy settings");
        assert!(legacy.global_shortcut_enabled);
        assert_eq!(legacy.global_shortcut, "CommandOrControl+Alt+T");
        assert_eq!(legacy.create_shortcut, "Control+Alt+KeyQ");
        assert!(legacy.zentao_assigned_only);
        assert_eq!(legacy.zentao_url, "");
    }

    #[test]
    fn migrates_ctrl_space_create_shortcut_off_the_ime_toggle() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("tododock.db");
        drop(Database::open(&path).expect("create current database"));
        {
            let connection = Connection::open(&path).expect("open database as v3");
            let settings = AppSettings {
                create_shortcut: "Control+Space".to_string(),
                ..AppSettings::default()
            };
            let encoded = serde_json::to_string(&settings).expect("encode settings");
            connection
                .execute(
                    "INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES ('app_settings', ?1, 1)",
                    [encoded],
                )
                .expect("store conflicting shortcut");
            connection
                .execute_batch("PRAGMA user_version = 3;")
                .expect("mark schema v3");
        }

        let database = Database::open(&path).expect("migrate v3 database");
        let settings = database.load_settings().expect("load migrated settings");
        assert_eq!(settings.create_shortcut, "Control+Alt+KeyQ");
        assert_eq!(
            schema_version(&database.connection.lock().expect("lock database")).expect("schema"),
            CURRENT_SCHEMA_VERSION
        );
    }

    #[test]
    fn syncs_zentao_tasks_by_external_id() {
        let database = Database::open_in_memory().expect("open database");
        let task = ExternalTask {
            id: "88".to_string(),
            title: "接口联调".to_string(),
            body: "来自禅道 #88".to_string(),
            open: true,
            priority: 2,
            deadline_at: None,
        };
        let created = database
            .sync_external_todos("zentao", std::slice::from_ref(&task), 15)
            .expect("create from zentao");
        assert_eq!(created.created, 1);
        let updated_task = ExternalTask {
            title: "接口联调-改".to_string(),
            ..task.clone()
        };
        let updated = database
            .sync_external_todos("zentao", std::slice::from_ref(&updated_task), 15)
            .expect("update from zentao");
        assert_eq!(updated.updated, 1);
        let open = database
            .list_todos(&ListTodosInput {
                filter: "open".to_string(),
                search: String::new(),
            })
            .expect("list open");
        assert_eq!(open[0].title, "接口联调-改");
        let done = ExternalTask {
            open: false,
            ..updated_task
        };
        let completed = database
            .sync_external_todos("zentao", &[done], 15)
            .expect("complete from zentao");
        assert_eq!(completed.completed, 1);
        assert_eq!(
            database
                .list_todos(&ListTodosInput {
                    filter: "completed".to_string(),
                    search: String::new(),
                })
                .expect("list completed")
                .len(),
            1
        );
    }

    #[test]
    fn quiet_hours_support_daytime_and_overnight_ranges() {
        assert_eq!(quiet_end_day_offset(13 * 60, 12 * 60, 14 * 60), Some(0));
        assert_eq!(quiet_end_day_offset(15 * 60, 12 * 60, 14 * 60), None);
        assert_eq!(quiet_end_day_offset(23 * 60, 22 * 60, 8 * 60), Some(1));
        assert_eq!(quiet_end_day_offset(7 * 60, 22 * 60, 8 * 60), Some(0));
        assert_eq!(quiet_end_day_offset(12 * 60, 22 * 60, 8 * 60), None);
    }

    #[test]
    fn quiet_hour_end_resolves_dst_gaps_and_ambiguity_safely() {
        let base = chrono::NaiveDate::from_ymd_opt(2030, 3, 10)
            .expect("valid date")
            .and_hms_opt(2, 30, 0)
            .expect("valid wall clock");
        let after_gap = base + chrono::Duration::minutes(30);
        assert_eq!(
            resolve_local_datetime(base, |candidate| {
                if candidate < after_gap {
                    chrono::LocalResult::None
                } else {
                    chrono::LocalResult::Single(candidate)
                }
            }),
            Some(after_gap)
        );
        assert_eq!(
            resolve_local_datetime(base, |_| chrono::LocalResult::Ambiguous(1, 2)),
            Some(2)
        );
    }

    #[test]
    fn export_preview_and_import_todos_without_replacing_local_settings() {
        let source = Database::open_in_memory().expect("open source database");
        source.create_todo(&sample_input()).expect("create todo");
        let exported_settings = AppSettings {
            theme: "dark".to_string(),
            ..AppSettings::default()
        };
        source
            .save_settings(&exported_settings)
            .expect("save source settings");

        let exported = source.export_bundle("test").expect("export data");
        let json = serde_json::to_string(&exported).expect("serialize export");
        let decoded: ExportBundle = serde_json::from_str(&json).expect("decode export");

        let destination = Database::open_in_memory().expect("open destination database");
        let local_settings = AppSettings {
            theme: "light".to_string(),
            global_shortcut: "CommandOrControl+Alt+T".to_string(),
            launch_at_login: true,
            ..AppSettings::default()
        };
        destination
            .save_settings(&local_settings)
            .expect("save local settings");
        let preview = destination
            .preview_import(&decoded)
            .expect("preview import");
        assert_eq!(preview.total, 1);
        assert_eq!(preview.new_count, 1);
        destination.import_bundle(&decoded).expect("import data");
        let imported = destination
            .list_todos(&ListTodosInput {
                filter: "open".to_string(),
                search: String::new(),
            })
            .expect("list imported todos");
        assert_eq!(imported.len(), 1);
        assert_eq!(
            destination.load_settings().expect("load settings"),
            local_settings
        );
    }

    #[test]
    fn import_can_recover_todos_when_unused_bundle_settings_are_invalid() {
        let source = Database::open_in_memory().expect("open source database");
        source.create_todo(&sample_input()).expect("create todo");
        let mut bundle = source.export_bundle("test").expect("export source");
        bundle.settings.theme = "invalid-theme".to_string();

        let destination = Database::open_in_memory().expect("open destination database");
        assert!(destination.preview_import(&bundle).is_ok());
        assert!(destination.import_bundle(&bundle).is_ok());
        assert!(destination.preview_restore(&bundle).is_err());
        assert_eq!(
            destination.load_settings().expect("load settings"),
            AppSettings::default()
        );
    }

    #[test]
    fn restore_replaces_existing_todos_in_one_transaction() {
        let source = Database::open_in_memory().expect("open source database");
        let restored_todo = source
            .create_todo(&sample_input())
            .expect("create source todo");
        let restored_settings = AppSettings {
            theme: "dark".to_string(),
            ..AppSettings::default()
        };
        source
            .save_settings(&restored_settings)
            .expect("save source settings");
        let bundle = source.export_bundle("test").expect("export source");

        let destination = Database::open_in_memory().expect("open destination database");
        destination
            .save_settings(&AppSettings {
                theme: "light".to_string(),
                ..AppSettings::default()
            })
            .expect("save destination settings");
        let mut first = sample_input();
        first.title = "Current one".to_string();
        destination.create_todo(&first).expect("create current one");
        let mut second = sample_input();
        second.title = "Current two".to_string();
        destination
            .create_todo(&second)
            .expect("create current two");

        let preview = destination
            .preview_restore(&bundle)
            .expect("preview restore");
        assert_eq!(preview.total, 1);
        assert_eq!(preview.add_count, 1);
        assert_eq!(preview.replace_count, 0);
        assert_eq!(preview.remove_count, 2);

        let restored = destination.restore_bundle(&bundle).expect("restore bundle");
        assert_eq!(restored, preview);
        let todos = destination
            .list_todos(&ListTodosInput {
                filter: "open".to_string(),
                search: String::new(),
            })
            .expect("list restored todos");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].id, restored_todo.id);
        assert_eq!(
            destination.load_settings().expect("load restored settings"),
            restored_settings
        );
    }

    #[test]
    fn failed_import_rolls_back_every_todo_change() {
        let source = Database::open_in_memory().expect("open source database");
        let mut first = sample_input();
        first.title = "Imported before failure".to_string();
        source
            .create_todo(&first)
            .expect("create first source todo");
        let mut second = sample_input();
        second.title = "Trigger import failure".to_string();
        source
            .create_todo(&second)
            .expect("create second source todo");
        let bundle = source.export_bundle("test").expect("export source");

        let destination = Database::open_in_memory().expect("open destination database");
        destination
            .connection
            .lock()
            .expect("database lock")
            .execute_batch(
                "CREATE TRIGGER fail_import_before_insert
                 BEFORE INSERT ON todos
                 WHEN NEW.title = 'Trigger import failure'
                 BEGIN
                   SELECT RAISE(ABORT, 'simulated import failure');
                 END;",
            )
            .expect("create failure trigger");

        assert!(destination.import_bundle(&bundle).is_err());
        assert!(
            destination
                .list_todos(&ListTodosInput {
                    filter: "open".to_string(),
                    search: String::new(),
                })
                .expect("list destination todos")
                .is_empty()
        );
    }

    #[test]
    fn failed_restore_rolls_back_todos_settings_and_reminder_state() {
        let destination = Database::open_in_memory().expect("open destination database");
        let now = 1_900_000_000_000;
        let mut current_input = sample_input();
        current_input.title = "Current protected todo".to_string();
        current_input.deadline_at = Some(now);
        current_input.reminder_minutes = Some(0);
        let current = destination
            .create_todo(&current_input)
            .expect("create current todo");
        let local_settings = AppSettings {
            theme: "light".to_string(),
            ..AppSettings::default()
        };
        destination
            .save_settings(&local_settings)
            .expect("save local settings");
        assert_eq!(
            destination
                .claim_due_reminders(now)
                .expect("claim current reminder")
                .len(),
            1
        );

        let source = Database::open_in_memory().expect("open source database");
        let mut first = sample_input();
        first.title = "Restored before failure".to_string();
        source
            .create_todo(&first)
            .expect("create first source todo");
        let mut second = sample_input();
        second.title = "Trigger restore failure".to_string();
        source
            .create_todo(&second)
            .expect("create second source todo");
        let bundle = source.export_bundle("test").expect("export source");

        destination
            .connection
            .lock()
            .expect("database lock")
            .execute_batch(
                "CREATE TRIGGER fail_restore_before_insert
                 BEFORE INSERT ON todos
                 WHEN NEW.title = 'Trigger restore failure'
                 BEGIN
                   SELECT RAISE(ABORT, 'simulated restore failure');
                 END;",
            )
            .expect("create failure trigger");

        assert!(destination.restore_bundle(&bundle).is_err());
        let todos = destination
            .list_todos(&ListTodosInput {
                filter: "open".to_string(),
                search: String::new(),
            })
            .expect("list rolled back todos");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].id, current.id);
        assert_eq!(
            destination.load_settings().expect("load local settings"),
            local_settings
        );
        let pending = destination
            .list_pending_reminders()
            .expect("list rolled back reminders");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].todo_id, current.id);
    }

    #[test]
    fn rejects_unknown_export_versions() {
        let database = Database::open_in_memory().expect("open database");
        let mut exported = database.export_bundle("test").expect("export data");
        exported.format_version = 99;
        assert!(database.preview_import(&exported).is_err());
    }

    #[test]
    fn rejects_exported_todos_with_inconsistent_status_timestamps() {
        let database = Database::open_in_memory().expect("open database");
        let created = database.create_todo(&sample_input()).expect("create todo");
        let mut exported = database.export_bundle("test").expect("export data");
        exported.todos.push(Todo {
            id: Uuid::now_v7().to_string(),
            completed_at: Some(created.created_at),
            ..created.clone()
        });
        assert!(database.preview_import(&exported).is_err());

        let mut exported = database.export_bundle("test").expect("export data");
        exported.todos.push(Todo {
            id: Uuid::now_v7().to_string(),
            created_at: created.updated_at,
            updated_at: created.created_at - 1,
            ..created
        });
        assert!(database.preview_restore(&exported).is_err());
    }

    #[test]
    fn completing_a_previously_archived_todo_clears_archive_timestamp() {
        let database = Database::open_in_memory().expect("open database");
        let created = database.create_todo(&sample_input()).expect("create todo");
        database
            .set_archived(&created.id, true)
            .expect("archive todo");
        let completed = database
            .set_completed(&created.id, true)
            .expect("complete archived todo");
        assert_eq!(completed.status, "completed");
        assert!(completed.completed_at.is_some());
        assert!(completed.archived_at.is_none());
    }

    #[test]
    #[ignore = "performance probe; run explicitly with --ignored --nocapture"]
    fn measures_ten_thousand_todo_search_latency() {
        let database = Database::open_in_memory().expect("open database");
        insert_performance_todos(&database, None, None);

        let mut samples = Vec::new();
        for _ in 0..30 {
            let started = std::time::Instant::now();
            let results = database
                .list_todos(&ListTodosInput {
                    filter: "open".to_string(),
                    search: "needle".to_string(),
                })
                .expect("search todos");
            assert_eq!(results.len(), 104);
            samples.push(started.elapsed());
        }
        samples.sort_unstable();
        let p95 = samples[28];
        println!("10k todo search p95: {:.2} ms", p95.as_secs_f64() * 1_000.0);
        assert!(p95 < std::time::Duration::from_millis(1_000));
    }

    #[test]
    #[ignore = "performance probe; run explicitly with --ignored --nocapture"]
    fn measures_ten_thousand_todo_reminder_scan_latency() {
        let database = Database::open_in_memory().expect("open database");
        let now = 1_900_000_000_000_i64;
        let deadline = now + 24 * 60 * 60_000;
        insert_performance_todos(&database, Some(deadline), Some(15));

        let mut samples = Vec::new();
        for _ in 0..30 {
            let started = std::time::Instant::now();
            assert_eq!(
                database.next_reminder_at(now).expect("scan reminders"),
                Some(deadline - 15 * 60_000)
            );
            samples.push(started.elapsed());
        }
        samples.sort_unstable();
        let p95 = samples[28];
        println!(
            "10k todo reminder scan p95: {:.2} ms",
            p95.as_secs_f64() * 1_000.0
        );
        assert!(p95 < std::time::Duration::from_millis(1_000));
    }
}
