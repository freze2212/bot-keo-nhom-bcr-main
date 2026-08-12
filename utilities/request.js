const axios = require("axios");
require("dotenv").config();

const { getCurrentTime } = require("./helper");

const HALL_HEADERS = {
  "accept-language": "vi-VN,vi;q=0.9",
  accept: "application/json, text/plain, */*",
  "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
};

const AXIOS_OPTS = {
  // Poll fallback không được chặn luồng round/capture quá lâu khi Hall lỗi.
  timeout: 12000,
  maxRedirects: 5,
};

async function requestData(sessionId, sessionBaseUrl) {
  const base = sessionBaseUrl || process.env.URI_REQUEST_DATA;
  if (!base) {
    console.error("URI_REQUEST_DATA missing in .env");
    return {};
  }
  const url = base + sessionId;
  const payload = new URLSearchParams();
  payload.append("gameGroupId", 2);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await axios.post(url, payload, {
        ...AXIOS_OPTS,
        headers: HALL_HEADERS,
      });
      if (response.data?.tableItems) return response.data;
      if (attempt === 2) {
        console.error(
          "Hall API empty tableItems — check URI_REQUEST_DATA domain matches session (e.g. bpcdf.doerkm88.com)"
        );
      }
    } catch (error) {
      const host = (() => {
        try {
          return new URL(base).host;
        } catch {
          return base;
        }
      })();
      console.error(
        `Error calling API host=${host} attempt=${attempt}:`,
        error.message
      );
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return {};
}

async function CollectingResponseSession(response, isCollecting) {
  if (!isCollecting) return;

  const url = response.url();
  const status = response.status();
  const request = response.request();
  const resourceType = request.resourceType();
  try {
    // Debug log để kiểm tra
    console.log(`[DEBUG] Response: ${resourceType} - ${url}`);
    console.log(await response.text());
        if (url.toLowerCase().includes("jsessionid=")) {
      const match = url.match(/jsessionid=([a-zA-Z0-9]+)/i);
      const sessionId = match ? match[1] : undefined;
      if (sessionId) {
        console.log(`[SESSION MATCHED] Found sessionId: ${sessionId} from URL: ${url}`);
        return sessionId;
      }
    }
  } catch (error) {
    console.error("[ERROR] CollectingResponseSession:", error.message);
    return undefined;
  }
  return undefined;
}

async function CollectingResponseSessionV2(response, isCollecting) {
  if (!isCollecting) return;

  const url = response.url();
  const request = response.request();
  const resourceType = request.resourceType();
  const debugNetwork = process.env.DEBUG_NETWORK === "1";

  try {
    if (debugNetwork) console.log(`[DEBUG] Response: ${resourceType} - ${url}`);
    if (resourceType === "xhr" || resourceType === "fetch") {
      // sảnh rất thường hay đổi domain chỉ cần request có session thì sẽ lấy
      // Lấy headers từ request thay vì từ URL
      const headers = request.headers();
      const cookieHeader = headers["cookie"] || headers["Cookie"];

      let sessionId = undefined;

      if (cookieHeader) {
        // Tìm JSESSIONID trong cookie header
        const jsessionidMatch = cookieHeader.match(/JSESSIONID=([^;]+)/);
        sessionId = jsessionidMatch ? jsessionidMatch[1] : undefined;

        if (sessionId) {
          return sessionId;
        }
      }

      // Nếu không tìm thấy trong cookie, thử tìm trong URL (fallback)
      const urlMatch = url.match(/jsessionid=([^?]+)/i);
      sessionId = urlMatch ? urlMatch[1] : undefined;

      if (sessionId) {
        return sessionId;
      }

      if (debugNetwork) console.log(`[SESSION] No sessionId found for URL: ${url}`);
      return undefined;
    }
  } catch (error) {
    console.error("[ERROR] CollectingResponseSession:", error.message);
    return undefined;
  }
  return undefined;
}

async function callQueryInitWebGameHall(sessionId) {
  const url = process.env.URI_REQUEST_DATA + sessionId;
  const payload = new URLSearchParams();
  payload.append("gameGroupId", 2);

  try {
    const response = await axios.post(url, payload, {
      ...AXIOS_OPTS,
      headers: HALL_HEADERS,
    });
    return response.data;
  } catch (error) {
    console.error("Error calling API:", error.message);
    return null;
  }
}

async function sendTelegramMessage(token, idRecipient, message) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    await axios.post(url, {
      chat_id: idRecipient,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error("Lỗi khi gửi Telegram:", err.response?.data || err.message);
  }
}

module.exports = {
  callQueryInitWebGameHall,
  CollectingResponseSession,
  CollectingResponseSessionV2,
  sendTelegramMessage,
  requestData,
};
