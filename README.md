# DeepSeek Code Agent

A local-first VS Code coding agent that uses an existing, signed-in DeepSeek chat tab as its reasoning provider. It does not ask for DeepSeek credentials, read browser cookies, or call a paid model API. The model proposes strict JSON operations; the VS Code extension validates, previews, and asks before changing files or running commands.

## Architecture

- `extensions/vscode` is the VS Code sidebar, workspace context collector, review/apply controller, command runner, conversation store, and loopback HTTP bridge.
- `extensions/browser` is a Chromium Manifest V3 extension. Its service worker pairs with the local bridge, receives the validated conversation URL with each task, and reuses or navigates one official DeepSeek tab. `src/adapter.ts` contains website-specific selectors and interaction code.
- `packages/protocol` defines the Zod-validated JSON response format, bridge messages, prompt instructions, and provider-side validation.
- The browser bridge listens only on `127.0.0.1`. VS Code displays a one-time pairing code; the browser popup exchanges it for a random bearer token stored in extension-local storage. When **Auto connect** is enabled, VS Code also keeps the matching token in SecretStorage so the paired extension reconnects after a VS Code restart. The initial one-time pairing remains required. Requests have UUID correlation IDs, bounded sizes and timeouts. Neither component handles website credentials or cookies.

The **DeepSeek conversation** toolbar menu in the VS Code chat lets you save the conversation URL and choose whether to reconnect automatically after the first pairing. The URL is also available as `deepseekCodeAgent.conversationUrl` in VS Code Settings. Only HTTPS conversation links on the exact `chat.deepseek.com` origin with a UUID chat ID are accepted. The URL is sent to the browser extension with each task and is not stored in browser-extension settings. Before each prompt, the browser extension finds or opens that URL, verifies the loaded tab URL, and waits for the chat input to be available. This confirms that the configured page is ready, not that DeepSeek restored the expected visible history; inspect the conversation in the browser when selecting its link. Pairing, page/input readiness, and a completed response are reported separately. Website layout changes, sign-in requirements, unavailable tabs, navigation failures, and timeouts are surfaced instead of silently falling back. DeepSeek can change its website without notice; selectors are isolated in `extensions/browser/src/adapter.ts` and must be maintained if that happens.

## Requirements

- Node.js 22 or later and npm.
- VS Code 1.97 or later.
- Chromium-based browser with access to the official DeepSeek chat website.
- An existing authenticated DeepSeek browser session. Sign in on the DeepSeek website yourself; do not enter credentials in this project.

## Install and run locally

From the repository root:

```sh
npm install
npm run build
npm test
npm run lint
```

1. In VS Code, open **Extensions: Install from VSIX** after packaging below, or launch a development window with:

   ```sh
   code --new-window --extensionDevelopmentPath="<absolute path to repository>/extensions/vscode" "<absolute path to your project>"
   ```

2. In that VS Code window, open a trusted project folder and select **DeepSeek Agent** in the Activity Bar. The sidebar shows the local bridge port and one-time pairing code until the browser extension is paired.
3. In Chromium, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extensions/browser/dist`.
4. Open the **DeepSeek conversation** menu in the VS Code chat, enter and save the signed-in conversation URL, and choose the browser reconnection preference. Inspect the selected conversation in the browser yourself; a URL cannot prove which history DeepSeek restored. In the browser extension popup, use the bridge URL `http://127.0.0.1:43127` (or the configured VS Code port), enter the displayed one-time code, and select **Pair with VS Code**.
5. Use **Check status** in the popup to distinguish pairing from page/input readiness. A task locates or opens the saved URL and checks its URL and chat input before submitting. Run **DeepSeek Agent: Diagnose Bridge** from the VS Code Command Palette for bridge/pairing diagnostics.

With **deepseekCodeAgent.autoConnect** enabled (the default), the first pairing code is still required, then the secure pairing token is restored from VS Code SecretStorage after extension-host restarts and the browser reconnects automatically. Disable this option to require pairing again after restart. Reinstalling or clearing browser-extension storage also requires pairing again. Browser-side polling resumes automatically while paired. The VS Code **New** action archives the local conversation, opens DeepSeek's new-chat page in the paired browser, and starts a fresh local session. The first prompt creates the website conversation; after its response, the extension saves DeepSeek's actual conversation URL for following tasks.
Conversation history survives an extension-host restart. An in-flight task is not resumed automatically; on restart the extension records that it was interrupted and asks you to review workspace changes and resubmit it.

## Safety and behavior

- Model output is parsed as versioned JSON. A complete JSON object can be extracted from surrounding prose, but malformed/truncated output is never repaired heuristically or partially applied; up to three complete correction attempts are requested. Duplicate paths, missing fields, unsupported operations, and unsafe relative paths are rejected before execution.
- Workspace context prioritizes project instructions, task-related source/tests, the active editor, manifests, diagnostics, and task-relevant Git changes. Long files are sent as marked excerpts until the model requests full contents; unchanged context already supplied during a task is not resent. Context is bounded. Build output, dependency trees, caches, virtual environments, Git internals, common credential files, and user-configured globs are excluded. Secret-like assignments, common token formats, bearer tokens, URL credentials, and private-key blocks are redacted. Process environment variables are never collected.
- The prompt includes the structured protocol with the initial task request, then asks for the current task and only changed/new context on follow-up turns. A materially ambiguous task can return one focused clarification without proposing edits or commands; answer in the composer to continue.
- The sidebar uses a familiar VS Code chat layout with a compact conversation toolbar, scrollable transcript, persistent composer, and status/proposal controls. Approval requests appear inline above the message input with explicit **Approve** and **Don't allow** actions instead of modal approval popups. Reviewing file edits also opens VS Code diffs. An expandable **Thinking** panel shows task progress and a concise user-facing approach summary from the structured plan; it does not expose hidden model reasoning. Raw protocol JSON is not displayed as an assistant message. It uses **Enter** to send and **Shift+Enter** for a newline. Choose **Ask before edits / commands** to review proposed edits and commands; **Auto-apply safe changes** skips edit approvals and runs only exact commands in the trusted-command list without prompts, while deletions still need approval; or **Auto-apply everything** to skip approval prompts for all file changes, deletions, and commands accepted by the existing command-safety checks. Those checks and workspace path validation remain enabled in every mode, so blocked commands are still refused. Errors include a retry action and retain the selected approval mode.
- File edits are restricted to the first workspace folder, reject path traversal and symlinks, and in review mode show VS Code diffs and require explicit approval in the chat composer. Auto modes apply creations/replacements without the diff approval step. Deletions require approval in review and safe auto modes; auto-apply everything honors the explicit mode choice and deletes without a prompt, while keeping an exact-byte backup in VS Code extension storage. Files with unsaved editor changes and binary files are refused. File changes are checked for external modifications before applying and saved through VS Code document APIs.
- Commands are displayed exactly and require approval in the chat composer in review mode, or in safe auto mode unless the exact command is in the trusted-command list. Auto-apply everything skips the prompt for commands accepted by validation. Commands run without a shell, with captured output, exit status, timeout, and cancellation. Shell chaining, arbitrary executables, network tools, destructive commands, package installation/launch (`npm exec`), `npx`, and Python scripts are blocked in every mode. The trusted-command list cannot override safety checks. The extension uses VS Code workspace APIs and does not request broad operating-system file or process permissions; workspace trust and command safety validation remain active.
- Verification is not claimed unless commands actually exit successfully. Configure project-specific verification commands under `deepseekCodeAgent.verificationCommands`; in review mode they still require approval, and in safe auto mode they run without prompts only if each exact command is trusted. `deepseekCodeAgent.maxIterations`, `maxResponseBytes`, `commandTimeoutSeconds`, `contextLimitBytes`, `excludedGlobs`, and `trustedCommands` control the task limits and policy.
- The task can be stopped from the sidebar at any time. Cancellation stops waiting for DeepSeek and terminates the active local command. Already-applied approved changes are retained and reported.
- Local conversations are stored in VS Code workspace state (up to 40 current messages and 20 archived sessions). Logs avoid prompt/response content; browser bridge failures may be shown in the UI.

This is an experimental integration with a third-party website, not an official DeepSeek API or partnership. DeepSeek account, availability, site behavior, quotas, and terms remain controlled by DeepSeek. Do not send confidential data unless you are authorized to share it with that service. No CAPTCHA, access control, authentication flow, or usage limit is bypassed.

## Package and install

Build the browser extension with `npm run package:browser`, then load `extensions/browser/dist` as an unpacked extension. To package the VS Code extension:

```sh
npm run package -w deepseek-code-agent-vscode
```

This writes a `.vsix` in `extensions/vscode`; install it using **Extensions: Install from VSIX**. The VS Code extension bundles its protocol/runtime dependencies.

## Troubleshooting

- **No pairing code or port conflict:** run **DeepSeek Agent: Diagnose Bridge**. Change `deepseekCodeAgent.bridgePort` and update the popup URL if another local service owns the default port. Auto connect only skips re-pairing after the first explicit code exchange; it does not bypass initial pairing.
- **Pairing rejected:** use the newest code shown by the current VS Code extension host. The code is single-use and expires when that host restarts. The bridge accepts only `127.0.0.1`.
- **Paired but chat unavailable:** verify `deepseekCodeAgent.conversationUrl` and sign in manually in the browser. When a task starts, the extension waits for the matching page and chat input, then automatically retries navigation or reloads the page once if readiness times out. If it is still unavailable, use **Check status** and check for a DeepSeek layout change. URL and input readiness do not prove the configured conversation's contents.
- **Wrong conversation or URL rejected:** set `deepseekCodeAgent.conversationUrl` to an official HTTPS `chat.deepseek.com` conversation URL with a conversation chat ID. The agent verifies the active tab against this URL before sending anything and will reuse its tab or navigate an existing DeepSeek tab.
- **Input/response selector not found or request times out:** check for a DeepSeek site update, reload the chat page, and inspect `extensions/browser/src/adapter.ts`. Unsupported layouts fail explicitly; never paste credentials or cookies into the bridge.
- **Real-site verification:** unit tests cover URL policy, tab-selection decisions, and readiness timeout behavior only. They do not prove that DeepSeek restores a selected chat URL or exposes the expected DOM in a real signed-in session. Set the conversation URL in the VS Code sidebar, inspect the correct chat, run **Check status** from the browser popup, submit a harmless prompt, and confirm the answer appears in that same conversation before relying on the integration.
- **Workspace is not trusted:** trust the folder in VS Code before running the agent. Untrusted workspaces are refused.
- **No changes applied:** inspect the proposed diff and approval prompts. Exact search-and-replace occurrence mismatches and files edited externally are refused; ask the agent to collect the current file and regenerate its proposal.
- **Verification not performed:** approve one of the proposed verification commands or configure `deepseekCodeAgent.verificationCommands`. A model's summary alone is not treated as test evidence.

## Development checks

`npm test` runs protocol/provider-mock tests, context ranking/limit and task-prompt tests, workspace-path/secret-scan/command-safety/state tests, and browser URL persistence/tab-plan/readiness/reload-recovery tests. These are unit/mock checks, not live DeepSeek website integration tests. `npm run lint` runs TypeScript checks and ESLint; `npm run format` applies Prettier and `npm run format:check` checks formatting. Browser DOM selection and streaming behavior are isolated for focused maintenance because DeepSeek does not publish a stable DOM contract.
