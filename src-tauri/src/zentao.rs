use std::time::Duration;

use chrono::{Local, NaiveDate, TimeZone};
use md5::{Digest, Md5};
use serde_json::{Value, json};

use crate::models::AppSettings;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_TASKS: usize = 500;

#[derive(Debug, Clone, PartialEq)]
pub struct ExternalTask {
    pub id: String,
    pub title: String,
    pub body: String,
    pub open: bool,
    pub priority: i64,
    pub deadline_at: Option<i64>,
}

pub trait ZentaoHttp {
    fn request(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Value, String>;
}

pub struct UreqClient {
    agent: ureq::Agent,
}

impl Default for UreqClient {
    fn default() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout(REQUEST_TIMEOUT)
                .user_agent("TodoDock/0.1")
                .build(),
        }
    }
}

impl ZentaoHttp for UreqClient {
    fn request(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Value, String> {
        let mut request = if method.eq_ignore_ascii_case("post") {
            self.agent.post(url)
        } else {
            self.agent.get(url)
        };
        for (name, value) in headers {
            request = request.set(name, value);
        }
        let response = if let Some(body) = body {
            request
                .set("Content-Type", "application/json")
                .send_json(body.clone())
        } else {
            request.call()
        }
        .map_err(http_error)?;
        response.into_json::<Value>().map_err(|error| {
            log::error!("zentao response is not json: {error}");
            "禅道返回了无法解析的内容".to_string()
        })
    }
}

pub fn fetch_my_tasks(settings: &AppSettings) -> Result<Vec<ExternalTask>, String> {
    fetch_my_tasks_with(&UreqClient::default(), settings)
}

pub fn fetch_my_tasks_with(
    client: &impl ZentaoHttp,
    settings: &AppSettings,
) -> Result<Vec<ExternalTask>, String> {
    let base = normalize_base(&settings.zentao_url)?;
    if settings.zentao_account.trim().is_empty() || settings.zentao_password.is_empty() {
        return Err("请填写禅道账号和密码".to_string());
    }

    let session_result = fetch_via_session(client, &base, settings);
    if let Ok(tasks) = session_result {
        return Ok(filter_tasks(tasks, settings));
    }
    let rest_result = fetch_via_rest(client, &base, settings);
    match rest_result {
        Ok(tasks) => Ok(filter_tasks(tasks, settings)),
        Err(rest_error) => Err(format!(
            "无法从禅道同步：{}；REST 接口：{rest_error}",
            session_result.unwrap_err()
        )),
    }
}

fn filter_tasks(tasks: Vec<ExternalTask>, _settings: &AppSettings) -> Vec<ExternalTask> {
    tasks.into_iter().take(MAX_TASKS).collect()
}

fn fetch_via_session(
    client: &impl ZentaoHttp,
    base: &str,
    settings: &AppSettings,
) -> Result<Vec<ExternalTask>, String> {
    let session = client.request(
        "GET",
        &format!("{base}/api.php?m=api&f=getSessionID&t=json"),
        &[],
        None,
    )?;
    let data = unwrap_data(&session)?;
    let session_id =
        string_field(&data, "sessionID").ok_or_else(|| "禅道未返回会话 ID".to_string())?;
    let rand = string_field(&data, "rand").unwrap_or_default();
    let hashed = md5_hex(&format!("{}{rand}", md5_hex(&settings.zentao_password)));
    let login = client.request(
        "GET",
        &format!(
            "{base}/api.php?m=user&f=login&account={}&password={}&zentaosid={session_id}&t=json",
            urlencoding(&settings.zentao_account),
            urlencoding(&hashed)
        ),
        &[],
        None,
    )?;
    if login_failed(&login) {
        let fallback = client.request(
            "GET",
            &format!(
                "{base}/api.php?m=user&f=login&account={}&password={}&zentaosid={session_id}&t=json",
                urlencoding(&settings.zentao_account),
                urlencoding(&settings.zentao_password)
            ),
            &[],
            None,
        )?;
        if login_failed(&fallback) {
            return Err("禅道登录失败，请检查账号和密码".to_string());
        }
    }
    let assigned = if settings.zentao_assigned_only {
        "assignedTo"
    } else {
        "all"
    };
    let payload = client.request(
        "GET",
        &format!("{base}/api.php?m=my&f=task&t=json&type={assigned}&recPerPage=200&zentaosid={session_id}"),
        &[],
        None,
    )?;
    Ok(parse_task_list(
        &unwrap_data(&payload).unwrap_or(payload),
        None,
    ))
}

fn fetch_via_rest(
    client: &impl ZentaoHttp,
    base: &str,
    settings: &AppSettings,
) -> Result<Vec<ExternalTask>, String> {
    let token_body = json!({
        "account": settings.zentao_account.trim(),
        "password": settings.zentao_password,
    });
    let token_response = client.request(
        "POST",
        &format!("{base}/api.php/v1/tokens"),
        &[],
        Some(&token_body),
    )?;
    let token = string_field(&token_response, "token")
        .ok_or_else(|| zentao_error_message(&token_response, "禅道 Token 获取失败"))?;
    let headers = [("Token", token.as_str())];
    let profile = client.request("GET", &format!("{base}/api.php/v1/user"), &headers, None)?;
    let account = string_field(&profile, "account")
        .unwrap_or_else(|| settings.zentao_account.trim().to_string());
    let projects = client.request(
        "GET",
        &format!("{base}/api.php/v1/projects?limit=50"),
        &headers,
        None,
    )?;
    let mut tasks = Vec::new();
    for project in object_list(&projects, "projects") {
        let project_id = json_id(&project);
        if project_id.is_empty() {
            continue;
        }
        let executions = client.request(
            "GET",
            &format!("{base}/api.php/v1/projects/{project_id}/executions?limit=50"),
            &headers,
            None,
        )?;
        for execution in object_list(&executions, "executions") {
            let execution_id = json_id(&execution);
            if execution_id.is_empty() {
                continue;
            }
            let page = client.request(
                "GET",
                &format!("{base}/api.php/v1/executions/{execution_id}/tasks?limit=200&page=1"),
                &headers,
                None,
            )?;
            tasks.extend(parse_task_list(&page, Some(&account)));
            if tasks.len() >= MAX_TASKS {
                return Ok(tasks);
            }
        }
    }
    if tasks.is_empty() {
        let mine = client.request(
            "GET",
            &format!("{base}/api.php/v1/tasks?limit=200&assignedTo={account}"),
            &headers,
            None,
        );
        if let Ok(page) = mine {
            tasks.extend(parse_task_list(&page, Some(&account)));
        }
    }
    Ok(tasks)
}

pub fn parse_task_list(value: &Value, assigned_to: Option<&str>) -> Vec<ExternalTask> {
    collect_task_objects(value, 0)
        .into_iter()
        .filter_map(|item| parse_task(&item, assigned_to))
        .take(MAX_TASKS)
        .collect()
}

fn parse_task(value: &Value, assigned_to: Option<&str>) -> Option<ExternalTask> {
    let id = json_id(value);
    let title = string_field(value, "name").or_else(|| string_field(value, "title"))?;
    if id.is_empty() || title.trim().is_empty() {
        return None;
    }
    if let Some(expected) = assigned_to {
        let assigned = assigned_account(value);
        if !assigned.is_empty() && !assigned.eq_ignore_ascii_case(expected) {
            return None;
        }
    }
    let status = string_field(value, "status").unwrap_or_else(|| "wait".to_string());
    let open = matches!(status.as_str(), "wait" | "doing" | "pause" | "unclosed");
    Some(ExternalTask {
        id,
        title: truncate(&title, 240),
        body: build_body(value, &status),
        open,
        priority: map_priority(value.get("pri")),
        deadline_at: deadline_from_field(value.get("deadline")),
    })
}

fn build_body(value: &Value, status: &str) -> String {
    let desc = value
        .get("desc")
        .or_else(|| value.get("description"))
        .map(value_to_text)
        .unwrap_or_default();
    let cleaned = strip_html(&desc);
    let id = json_id(value);
    let mut body = if cleaned.is_empty() {
        format!("来自禅道 #{id}")
    } else {
        format!("{cleaned}\n\n来自禅道 #{id}")
    };
    body.push_str(&format!("\n状态：{status}"));
    truncate(&body, 100_000)
}

fn assigned_account(value: &Value) -> String {
    match value.get("assignedTo") {
        Some(Value::String(account)) => account.clone(),
        Some(Value::Object(map)) => map
            .get("account")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

fn map_priority(value: Option<&Value>) -> i64 {
    let pri = match value {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(3),
        Some(Value::String(text)) => text.parse().unwrap_or(3),
        _ => 3,
    };
    match pri {
        1 => 3,
        2 => 2,
        3 => 1,
        _ => 0,
    }
}

fn deadline_from_field(value: Option<&Value>) -> Option<i64> {
    let text = match value {
        Some(Value::String(text)) => text.as_str(),
        Some(Value::Number(number)) => return number.as_i64(),
        _ => return None,
    };
    if text.is_empty() || text.starts_with("0000") {
        return None;
    }
    let date = NaiveDate::parse_from_str(&text[..text.len().min(10)], "%Y-%m-%d").ok()?;
    let naive = date.and_hms_opt(18, 0, 0)?;
    Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| Local.from_local_datetime(&naive).earliest())
        .map(|datetime| datetime.timestamp_millis())
}

fn collect_task_objects(value: &Value, depth: usize) -> Vec<Value> {
    if depth > 5 {
        return Vec::new();
    }
    match value {
        Value::Array(items) => items
            .iter()
            .filter(|item| item.get("name").is_some() || item.get("id").is_some())
            .cloned()
            .collect(),
        Value::Object(map) => {
            if let Some(tasks) = map.get("tasks") {
                return collect_task_objects(tasks, depth + 1);
            }
            if map.values().any(|item| item.get("name").is_some()) {
                return map.values().cloned().collect();
            }
            map.values()
                .flat_map(|item| collect_task_objects(item, depth + 1))
                .collect()
        }
        _ => Vec::new(),
    }
}

fn unwrap_data(value: &Value) -> Result<Value, String> {
    match value.get("data") {
        Some(Value::String(text)) => {
            serde_json::from_str(text).map_err(|_| "禅道 data 字段无法解析".to_string())
        }
        Some(other) => Ok(other.clone()),
        None => Ok(value.clone()),
    }
}

fn login_failed(value: &Value) -> bool {
    match value.get("status") {
        Some(Value::String(status)) => !matches!(status.as_str(), "success" | "1"),
        Some(Value::Number(number)) => number.as_i64() != Some(1),
        _ => value.get("error").is_some() && value.get("user").is_none(),
    }
}

fn object_list(value: &Value, key: &str) -> Vec<Value> {
    match value.get(key) {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::Object(map)) => map.values().cloned().collect(),
        _ => match value {
            Value::Array(items) => items.clone(),
            _ => Vec::new(),
        },
    }
}

fn json_id(value: &Value) -> String {
    match value.get("id") {
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::Object(map)) => map
            .get("account")
            .or_else(|| map.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

pub fn strip_html(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut in_tag = false;
    for character in input.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }
    html_unescape(&output)
        .replace('\u{00a0}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn html_unescape(input: &str) -> String {
    input
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn md5_hex(input: &str) -> String {
    format!("{:x}", Md5::digest(input.as_bytes()))
}

fn urlencoding(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn truncate(value: &str, max_chars: usize) -> String {
    let count = value.chars().count();
    if count <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

pub fn normalize_base(url: &str) -> Result<String, String> {
    let trimmed = url.trim().trim_end_matches('/');
    let without_index = trimmed
        .trim_end_matches("/index.php")
        .trim_end_matches("/api.php/v1")
        .trim_end_matches("/api.php");
    if !(without_index.starts_with("http://") || without_index.starts_with("https://")) {
        return Err("禅道地址必须以 http:// 或 https:// 开头".to_string());
    }
    if without_index.len() > 300 {
        return Err("禅道地址过长".to_string());
    }
    if without_index.contains('@') {
        return Err("请不要在禅道地址中写入账号密码".to_string());
    }
    Ok(without_index.to_string())
}

fn zentao_error_message(value: &Value, fallback: &str) -> String {
    string_field(value, "error")
        .or_else(|| string_field(value, "message"))
        .unwrap_or_else(|| fallback.to_string())
}

fn http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, _) => format!("禅道 HTTP {code}"),
        other => {
            log::error!("zentao request failed: {other}");
            "无法连接禅道服务器".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct MapClient(HashMap<String, Value>);

    impl ZentaoHttp for MapClient {
        fn request(
            &self,
            method: &str,
            url: &str,
            _headers: &[(&str, &str)],
            _body: Option<&Value>,
        ) -> Result<Value, String> {
            let key = format!("{method} {url}");
            self.0
                .get(&key)
                .cloned()
                .or_else(|| {
                    self.0.iter().find_map(|(candidate, value)| {
                        candidate
                            .split_once(' ')
                            .and_then(|(candidate_method, candidate_url)| {
                                (candidate_method == method && url.contains(candidate_url))
                                    .then_some(value.clone())
                            })
                    })
                })
                .ok_or_else(|| format!("missing mock {key}"))
        }
    }

    fn settings() -> AppSettings {
        AppSettings {
            zentao_url: "https://zentao.example.com".to_string(),
            zentao_account: "demo".to_string(),
            zentao_password: "secret".to_string(),
            zentao_assigned_only: true,
            ..AppSettings::default()
        }
    }

    #[test]
    fn strips_html_and_maps_priority_and_deadline() {
        assert_eq!(strip_html("<p>修复&nbsp;<b>登录</b></p>"), "修复 登录");
        assert_eq!(map_priority(Some(&json!(1))), 3);
        assert!(deadline_from_field(Some(&json!("2026-09-01"))).is_some());
        assert_eq!(
            normalize_base("https://zentao.example.com/index.php/").unwrap(),
            "https://zentao.example.com"
        );
    }

    #[test]
    fn parses_classic_task_maps_and_rest_arrays() {
        let mapped = json!({
            "tasks": {
                "8": {"id": 8, "name": "接口联调", "status": "doing", "pri": 2, "assignedTo": "demo", "desc": "<p>明天</p>", "deadline": "2026-09-02"}
            }
        });
        let tasks = parse_task_list(&mapped, Some("demo"));
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "接口联调");
        assert!(tasks[0].open);
        assert_eq!(tasks[0].priority, 2);
        assert!(tasks[0].body.contains("来自禅道 #8"));

        let rest = json!({
            "tasks": [{"id": 9, "name": "别人的任务", "status": "wait", "assignedTo": {"account": "other"}, "pri": 4}]
        });
        assert!(parse_task_list(&rest, Some("demo")).is_empty());
    }

    #[test]
    fn session_login_reads_assigned_tasks() {
        let mut map = HashMap::new();
        map.insert(
            "GET getSessionID".to_string(),
            json!({"status":"success","data":"{\"sessionID\":\"sid\",\"rand\":\"99\"}"}),
        );
        map.insert(
            "GET login".to_string(),
            json!({"status":"success","user":{"account":"demo"}}),
        );
        map.insert(
            "GET my".to_string(),
            json!({"status":1,"data":{"tasks":[{"id":1,"name":"我的任务","status":"wait","pri":1,"assignedTo":"demo"}]}}),
        );
        let tasks = fetch_my_tasks_with(&MapClient(map), &settings()).expect("sync");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "我的任务");
        assert_eq!(tasks[0].priority, 3);
    }
}
