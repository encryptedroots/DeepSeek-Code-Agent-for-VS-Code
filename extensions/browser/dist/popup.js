"use strict";
(() => {
  // src/popup.ts
  var DEFAULT_BRIDGE_URL = "http://127.0.0.1:43127";
  var bridgeUrlInput = document.querySelector("#bridge-url");
  var pairingInput = document.querySelector("#pairing");
  var statusPanel = document.querySelector("#status");
  var statusText = document.querySelector("#status-text");
  function showStatus(message, state = "info") {
    statusPanel.hidden = false;
    statusPanel.dataset.state = state;
    statusText.textContent = message;
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
  void chrome.storage.local.get("baseUrl").then((stored) => {
    bridgeUrlInput.value = typeof stored.baseUrl === "string" ? stored.baseUrl : DEFAULT_BRIDGE_URL;
  }).catch((error) => {
    showStatus(
      error instanceof Error ? error.message : "Could not load settings. Check extension storage permissions.",
      "error"
    );
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
    showStatus("Checking VS Code pairing and configured conversation\u2026", "info");
    try {
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
