"use strict";
(() => {
  // src/chatUrl.ts
  var DEFAULT_CHAT_URL = "https://chat.deepseek.com/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c";
  var CHAT_PATH = /^\/a\/chat\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
  function validateDeepSeekChatUrl(input) {
    let url;
    try {
      url = new URL(input.trim());
    } catch {
      throw new Error("Enter a valid DeepSeek conversation URL.");
    }
    if (url.protocol !== "https:" || url.hostname !== "chat.deepseek.com" || url.origin !== "https://chat.deepseek.com" || url.username || url.password || url.search || url.hash || !CHAT_PATH.test(url.pathname)) {
      throw new Error(
        "Use an HTTPS conversation URL from chat.deepseek.com with a valid chat ID, such as https://chat.deepseek.com/a/chat/s/<chat-id>."
      );
    }
    return `https://chat.deepseek.com${url.pathname.replace(/\/$/, "")}`;
  }
  async function persistDeepSeekChatUrl(input, storage) {
    const chatUrl = validateDeepSeekChatUrl(input);
    await storage.set({ chatUrl });
    const saved = await storage.get("chatUrl");
    if (saved.chatUrl !== chatUrl) throw new Error("The browser could not verify the saved conversation URL. Try again.");
    return chatUrl;
  }

  // src/popup.ts
  var DEFAULT_BRIDGE_URL = "http://127.0.0.1:43127";
  var bridgeUrlInput = document.querySelector("#bridge-url");
  var chatUrlInput = document.querySelector("#chat-url");
  var pairingInput = document.querySelector("#pairing");
  var chatUrlForm = document.querySelector("#chat-url-form");
  var saveButton = document.querySelector("#save-chat-url");
  var saveState = document.querySelector("#save-state");
  var statusPanel = document.querySelector("#status");
  var statusText = document.querySelector("#status-text");
  function showStatus(message, state = "info") {
    statusPanel.hidden = false;
    statusPanel.dataset.state = state;
    statusText.textContent = message;
  }
  function showSaveState(message, state) {
    saveState.textContent = message;
    saveState.dataset.state = state;
    chatUrlInput.setAttribute("aria-invalid", state === "error" ? "true" : "false");
  }
  function sendBridgeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (typeof response !== "object" || response === null) {
          reject(new Error("The bridge did not return a response. Reload the extension and try again."));
          return;
        }
        resolve(response);
      });
    });
  }
  async function readStoredChatUrl() {
    const stored = await chrome.storage.local.get("chatUrl");
    if (typeof stored.chatUrl !== "string") return DEFAULT_CHAT_URL;
    return validateDeepSeekChatUrl(stored.chatUrl);
  }
  void chrome.storage.local.get(["baseUrl", "chatUrl"]).then((stored) => {
    bridgeUrlInput.value = typeof stored.baseUrl === "string" ? stored.baseUrl : DEFAULT_BRIDGE_URL;
    if (typeof stored.chatUrl !== "string") {
      chatUrlInput.value = DEFAULT_CHAT_URL;
      showSaveState("Example URL \u2014 save to keep this conversation.", "unsaved");
      return;
    }
    try {
      chatUrlInput.value = validateDeepSeekChatUrl(stored.chatUrl);
      showSaveState("Saved in this browser.", "saved");
    } catch (error) {
      chatUrlInput.value = stored.chatUrl;
      showSaveState(error instanceof Error ? error.message : "The saved URL is invalid. Replace it and save.", "error");
    }
  }).catch((error) => {
    showStatus(
      error instanceof Error ? error.message : "Could not load settings. Check extension storage permissions.",
      "error"
    );
  });
  chatUrlInput.addEventListener("input", () => {
    showSaveState("Unsaved changes \u2014 save this URL before using it.", "unsaved");
  });
  chatUrlForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!chatUrlForm.reportValidity()) return;
    saveButton.disabled = true;
    saveButton.textContent = "Saving\u2026";
    showSaveState("Validating and saving\u2026", "unsaved");
    try {
      const savedUrl = await persistDeepSeekChatUrl(chatUrlInput.value, chrome.storage.local);
      chatUrlInput.value = savedUrl;
      showSaveState("Saved and verified in this browser.", "saved");
      showStatus("Conversation link saved. The matching chat and input are checked before each task.", "success");
    } catch (error) {
      showSaveState(
        error instanceof Error ? error.message : "Could not save the URL. Check browser extension storage and try again.",
        "error"
      );
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "Save";
    }
  });
  document.querySelector("#pair").addEventListener("click", async () => {
    showStatus("Connecting to the local VS Code bridge\u2026", "info");
    try {
      const result = await sendBridgeMessage({
        type: "pair",
        baseUrl: bridgeUrlInput.value.trim(),
        code: pairingInput.value.trim()
      });
      showStatus(String(result.message ?? "Could not pair with VS Code."), result.ok ? "success" : "error");
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Pairing failed. Check the bridge address and code.", "error");
    }
  });
  document.querySelector("#health").addEventListener("click", async () => {
    try {
      const saved = await readStoredChatUrl();
      const entered = validateDeepSeekChatUrl(chatUrlInput.value);
      if (saved !== entered) throw new Error("Save the edited conversation URL before checking status.");
      showStatus("Checking VS Code pairing, browser, and conversation\u2026", "info");
      const result = await sendBridgeMessage({ type: "health" });
      showStatus(
        String(result.message ?? "Could not check bridge status."),
        result.pageAvailable === true && result.conversationMatched === true ? "success" : result.ok ? "info" : "error"
      );
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Could not check the configured conversation.", "error");
    }
  });
})();
//# sourceMappingURL=popup.js.map
