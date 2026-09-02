use std::time::Duration;

use serde_json::{Value, json};

use crate::models::{AppSettings, GeneratedTodoDraft, LlmImageInput, default_llm_model};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_IMAGES: usize = 8;
const MAX_IMAGE_BYTES: usize = 500_000;
const MAX_TODOS: usize = 20;
const MAX_TITLE_CHARS: usize = 240;
const MAX_BODY_CHARS: usize = 1_000_000;

const SYSTEM_PROMPT: &str = "你是 TodoDock 的待办提取助手。根据用户给出的一张或多张图片，提取其中明确的待办事项。\
只返回 JSON，不要 Markdown 围栏，不要解释：\
{\"todos\":[{\"title\":\"标题\",\"body\":\"可选 Markdown 正文，不要嵌入图片\",\"deadline\":\"可选的本地时间 YYYY-MM-DDTHH:mm 或 null\"}]}\
规则：必须输出 todos 数组；每张图可对应 0 或多条待办；多张图描述同一事项时合并为一条；\
标题 1-240 字且具体可执行；不要编造图片中没有的任务；不要把截图原文整段粘贴进标题。";

pub trait LlmHttp {
    fn post_json(&self, url: &str, bearer: Option<&str>, body: &Value) -> Result<Value, String>;
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

impl LlmHttp for UreqClient {
    fn post_json(&self, url: &str, bearer: Option<&str>, body: &Value) -> Result<Value, String> {
        let mut request = self.agent.post(url).set("Content-Type", "application/json");
        if let Some(token) = bearer {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        let response = request.send_json(body.clone()).map_err(http_error)?;
        response.into_json::<Value>().map_err(|error| {
            log::error!("llm response is not json: {error}");
            "大模型返回了无法解析的内容".to_string()
        })
    }
}

pub fn generate_todos_from_images(
    settings: &AppSettings,
    images: &[LlmImageInput],
) -> Result<Vec<GeneratedTodoDraft>, String> {
    generate_todos_from_images_with(&UreqClient::default(), settings, images)
}

pub fn generate_todos_from_images_with(
    client: &impl LlmHttp,
    settings: &AppSettings,
    images: &[LlmImageInput],
) -> Result<Vec<GeneratedTodoDraft>, String> {
    let endpoint = settings.llm_endpoint.trim();
    if endpoint.is_empty() {
        return Err("请先在设置中填写大模型端点".to_string());
    }
    let url = normalize_chat_completions_url(endpoint)?;
    let key = settings.llm_api_key.trim();
    if key.is_empty() && !is_loopback_endpoint(endpoint) {
        return Err("请先在设置中填写大模型 API 密钥".to_string());
    }
    validate_images(images)?;

    let model = if settings.llm_model.trim().is_empty() {
        default_llm_model()
    } else {
        settings.llm_model.trim().to_string()
    };
    let body = chat_request_body(&model, images);
    let bearer = if key.is_empty() { None } else { Some(key) };
    let response = client.post_json(&url, bearer, &body)?;
    let content = assistant_text(&response).ok_or_else(|| {
        llm_api_error_message(&response).unwrap_or_else(|| "大模型没有返回待办内容".to_string())
    })?;
    parse_generated_todos(&content)
}

pub fn normalize_chat_completions_url(endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim();
    if trimmed.len() > 300 {
        return Err("大模型端点过长".to_string());
    }
    if trimmed.contains('@') {
        return Err("请不要在大模型端点中写入密钥".to_string());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("大模型端点必须以 http:// 或 https:// 开头".to_string());
    }
    let without_slash = trimmed.trim_end_matches('/');
    if without_slash.ends_with("/chat/completions") {
        return Ok(without_slash.to_string());
    }
    Ok(format!("{without_slash}/chat/completions"))
}

pub fn is_loopback_endpoint(endpoint: &str) -> bool {
    let rest = endpoint
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let host = rest.split(['/', ':', '?', '#']).next().unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

pub fn validate_llm_settings(settings: &AppSettings) -> Result<(), String> {
    let endpoint = settings.llm_endpoint.trim();
    let key = settings.llm_api_key.trim();
    let model = settings.llm_model.trim();
    if endpoint.is_empty() && key.is_empty() && (model.is_empty() || model == default_llm_model()) {
        return Ok(());
    }
    if !endpoint.is_empty() {
        normalize_chat_completions_url(endpoint)?;
    } else if !key.is_empty() {
        return Err("请填写大模型端点".to_string());
    }
    if model.chars().count() > 80 {
        return Err("模型名称过长".to_string());
    }
    if key.len() > 512 {
        return Err("API 密钥过长".to_string());
    }
    Ok(())
}

fn validate_images(images: &[LlmImageInput]) -> Result<(), String> {
    if images.is_empty() {
        return Err("请先提供至少一张图片".to_string());
    }
    if images.len() > MAX_IMAGES {
        return Err(format!("一次最多使用 {MAX_IMAGES} 张图片"));
    }
    for image in images {
        let mime = image.mime.trim().to_ascii_lowercase();
        if !matches!(
            mime.as_str(),
            "image/jpeg" | "image/jpg" | "image/png" | "image/gif" | "image/webp"
        ) {
            return Err("仅支持 JPEG、PNG、GIF 或 WebP 图片".to_string());
        }
        let compact: String = image
            .data_base64
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        if compact.is_empty() {
            return Err("图片内容为空".to_string());
        }
        if !compact.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character == '+'
                || character == '/'
                || character == '='
        }) {
            return Err("图片数据无效".to_string());
        }
        let decoded_len = compact.len().saturating_mul(3) / 4;
        if decoded_len > MAX_IMAGE_BYTES {
            return Err("单张图片过大，请压缩后再试".to_string());
        }
    }
    Ok(())
}

fn chat_request_body(model: &str, images: &[LlmImageInput]) -> Value {
    let mut content = vec![json!({
        "type": "text",
        "text": format!("共 {} 张图片，请提取待办事项。", images.len()),
    })];
    for image in images {
        let mime = if image.mime.trim().eq_ignore_ascii_case("image/jpg") {
            "image/jpeg"
        } else {
            image.mime.trim()
        };
        let compact: String = image
            .data_base64
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        content.push(json!({
            "type": "image_url",
            "image_url": {
                "url": format!("data:{mime};base64,{compact}"),
                "detail": "high"
            }
        }));
    }
    json!({
        "model": model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": content }
        ]
    })
}

fn assistant_text(response: &Value) -> Option<String> {
    let message = response.pointer("/choices/0/message")?;
    match message.get("content") {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
        Some(Value::Array(parts)) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => response
            .pointer("/choices/0/text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|text| !text.trim().is_empty()),
    }
}

fn llm_api_error_message(response: &Value) -> Option<String> {
    let raw = response
        .pointer("/error/message")
        .or_else(|| response.get("error"))
        .and_then(|value| match value {
            Value::String(text) => Some(text.as_str()),
            Value::Object(map) => map.get("message").and_then(Value::as_str),
            _ => None,
        })?;
    let trimmed: String = raw.chars().take(160).collect();
    if trimmed.is_empty() {
        None
    } else {
        Some(format!("大模型请求失败：{trimmed}"))
    }
}

pub fn parse_generated_todos(content: &str) -> Result<Vec<GeneratedTodoDraft>, String> {
    let value = extract_json(content)?;
    let items = if let Some(todos) = value.get("todos").and_then(Value::as_array) {
        todos.clone()
    } else if let Some(todo) = value.get("todo") {
        vec![todo.clone()]
    } else if let Value::Array(array) = &value {
        array.clone()
    } else if value.get("title").is_some() {
        vec![value]
    } else {
        return Err("大模型没有返回待办列表".to_string());
    };

    let mut drafts = Vec::new();
    for item in items {
        let Some(title) = string_field(&item, "title")
            .or_else(|| string_field(&item, "task"))
            .or_else(|| string_field(&item, "name"))
        else {
            continue;
        };
        let title = truncate_chars(title.trim(), MAX_TITLE_CHARS);
        if title.is_empty() {
            continue;
        }
        let body = string_field(&item, "body")
            .or_else(|| string_field(&item, "notes"))
            .or_else(|| string_field(&item, "content"))
            .unwrap_or_default();
        drafts.push(GeneratedTodoDraft {
            title,
            body: truncate_chars(body.trim(), MAX_BODY_CHARS),
            deadline: normalize_deadline_field(&item),
        });
        if drafts.len() >= MAX_TODOS {
            break;
        }
    }
    if drafts.is_empty() {
        return Err("没有从图片中识别到待办事项".to_string());
    }
    Ok(drafts)
}

fn extract_json(content: &str) -> Result<Value, String> {
    let trimmed = content.trim();
    let unfenced = strip_markdown_fence(trimmed);
    if let Ok(value) = serde_json::from_str::<Value>(unfenced.trim()) {
        return Ok(value);
    }
    let start = unfenced
        .find(['{', '['])
        .ok_or_else(|| "大模型返回的内容不是 JSON".to_string())?;
    let snippet = &unfenced[start..];
    let end = snippet
        .rfind(['}', ']'])
        .ok_or_else(|| "大模型返回的内容不是 JSON".to_string())?;
    serde_json::from_str::<Value>(&snippet[..=end])
        .map_err(|_| "大模型返回的内容不是 JSON".to_string())
}

fn strip_markdown_fence(value: &str) -> &str {
    let trimmed = value.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let rest = rest
        .strip_prefix("json")
        .or_else(|| rest.strip_prefix("JSON"))
        .unwrap_or(rest)
        .trim_start_matches('\r')
        .trim_start_matches('\n');
    rest.strip_suffix("```").map(str::trim).unwrap_or(rest)
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn normalize_deadline_field(value: &Value) -> Option<String> {
    let raw = match value.get("deadline").or_else(|| value.get("due")) {
        Some(Value::Null) | None => return None,
        Some(Value::String(text)) => text.trim().to_string(),
        Some(other) => other.to_string(),
    };
    if raw.is_empty() || raw.eq_ignore_ascii_case("null") {
        return None;
    }
    let normalized = raw.replace(' ', "T");
    if is_date_only(&normalized) {
        return Some(format!("{normalized}T18:00"));
    }
    if normalized.len() >= 16 {
        let candidate = &normalized[..16];
        if is_date_time(candidate) {
            return Some(candidate.to_string());
        }
    }
    None
}

fn is_date_only(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                true
            } else {
                byte.is_ascii_digit()
            }
        })
}

fn is_date_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 16
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 4 | 7 | 10 | 13) {
                true
            } else {
                byte.is_ascii_digit()
            }
        })
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

fn http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(401, _) => "大模型 API 密钥无效".to_string(),
        ureq::Error::Status(403, _) => "大模型端点拒绝了请求".to_string(),
        ureq::Error::Status(429, _) => "大模型请求过于频繁，请稍后再试".to_string(),
        ureq::Error::Status(code, _) => format!("大模型 HTTP {code}"),
        other => {
            let display = other.to_string();
            if display.to_ascii_lowercase().contains("timed out")
                || display.to_ascii_lowercase().contains("timeout")
            {
                "大模型请求超时".to_string()
            } else {
                log::error!("llm request failed");
                "无法连接大模型端点".to_string()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AppSettings;

    struct MapClient {
        response: Result<Value, String>,
        last_url: std::sync::Mutex<Option<String>>,
        last_bearer: std::sync::Mutex<Option<String>>,
        last_body: std::sync::Mutex<Option<Value>>,
    }

    impl MapClient {
        fn ok(value: Value) -> Self {
            Self {
                response: Ok(value),
                last_url: std::sync::Mutex::new(None),
                last_bearer: std::sync::Mutex::new(None),
                last_body: std::sync::Mutex::new(None),
            }
        }
    }

    impl LlmHttp for MapClient {
        fn post_json(
            &self,
            url: &str,
            bearer: Option<&str>,
            body: &Value,
        ) -> Result<Value, String> {
            *self.last_url.lock().expect("url") = Some(url.to_string());
            *self.last_bearer.lock().expect("bearer") = bearer.map(str::to_string);
            *self.last_body.lock().expect("body") = Some(body.clone());
            match &self.response {
                Ok(value) => Ok(value.clone()),
                Err(error) => Err(error.clone()),
            }
        }
    }

    fn sample_image() -> LlmImageInput {
        LlmImageInput {
            mime: "image/png".to_string(),
            data_base64: "aGVsbG8=".to_string(),
        }
    }

    fn configured_settings() -> AppSettings {
        AppSettings {
            llm_endpoint: "https://api.x.ai/v1".to_string(),
            llm_api_key: "secret-key".to_string(),
            llm_model: "grok-4.5".to_string(),
            ..AppSettings::default()
        }
    }

    #[test]
    fn appends_chat_completions_to_openai_compatible_base() {
        assert_eq!(
            normalize_chat_completions_url("https://api.x.ai/v1/").unwrap(),
            "https://api.x.ai/v1/chat/completions"
        );
        assert_eq!(
            normalize_chat_completions_url("http://127.0.0.1:11434/v1/chat/completions").unwrap(),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
        assert!(normalize_chat_completions_url("javascript:alert(1)").is_err());
        assert!(is_loopback_endpoint("http://127.0.0.1:11434/v1"));
        assert!(!is_loopback_endpoint("https://api.x.ai/v1"));
    }

    #[test]
    fn parses_fenced_json_and_multiple_todos() {
        let drafts = parse_generated_todos(
            "```json\n{\"todos\":[{\"title\":\"买菜\",\"body\":\"牛奶\",\"deadline\":\"2026-09-03\"},{\"title\":\"回邮件\"}]}\n```",
        )
        .expect("parse");
        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].title, "买菜");
        assert_eq!(drafts[0].body, "牛奶");
        assert_eq!(drafts[0].deadline.as_deref(), Some("2026-09-03T18:00"));
        assert_eq!(drafts[1].title, "回邮件");
        assert_eq!(drafts[1].deadline, None);
    }

    #[test]
    fn generate_sends_all_images_and_keeps_key_out_of_url() {
        let client = MapClient::ok(json!({
            "choices": [{
                "message": {
                    "content": "{\"todos\":[{\"title\":\"整理截图\"}]}"
                }
            }]
        }));
        let images = vec![
            sample_image(),
            LlmImageInput {
                mime: "image/jpeg".to_string(),
                data_base64: "d29ybGQ=".to_string(),
            },
        ];
        let drafts = generate_todos_from_images_with(&client, &configured_settings(), &images)
            .expect("generate");
        assert_eq!(drafts[0].title, "整理截图");
        assert_eq!(
            client.last_url.lock().expect("url").as_deref(),
            Some("https://api.x.ai/v1/chat/completions")
        );
        assert_eq!(
            client.last_bearer.lock().expect("bearer").as_deref(),
            Some("secret-key")
        );
        let body = client
            .last_body
            .lock()
            .expect("body")
            .clone()
            .expect("body");
        let content = body["messages"][1]["content"].as_array().expect("content");
        assert_eq!(content.len(), 3);
        assert!(
            content[1]["image_url"]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
    }

    #[test]
    fn rejects_missing_key_for_remote_endpoint() {
        let settings = AppSettings {
            llm_endpoint: "https://api.x.ai/v1".to_string(),
            llm_api_key: String::new(),
            ..AppSettings::default()
        };
        let error = generate_todos_from_images_with(
            &MapClient::ok(json!({})),
            &settings,
            &[sample_image()],
        )
        .unwrap_err();
        assert!(error.contains("API 密钥"));
    }

    #[test]
    fn allows_empty_key_on_localhost() {
        let client = MapClient::ok(json!({
            "choices": [{ "message": { "content": "{\"todos\":[{\"title\":\"本地模型\"}]}" } }]
        }));
        let settings = AppSettings {
            llm_endpoint: "http://127.0.0.1:11434/v1".to_string(),
            llm_api_key: String::new(),
            ..AppSettings::default()
        };
        let drafts =
            generate_todos_from_images_with(&client, &settings, &[sample_image()]).expect("local");
        assert_eq!(drafts[0].title, "本地模型");
        assert!(client.last_bearer.lock().expect("bearer").is_none());
    }
}
