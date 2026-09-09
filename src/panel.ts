import * as vscode from 'vscode';
import { languageName } from './languages';

const SECTION = 'quickTranslate';
const HISTORY_KEY = 'history';

/** One answered request, as it is kept and as it is drawn. */
export interface HistoryEntry {
    source: string;
    translated: string;
    /** The language the engine reported, which under `auto` is what it detected. */
    from: string;
    to: string;
    at: number;
}

/** What the view needs from the extension to do anything but draw itself. */
export interface PanelHost {
    /** Translates text typed into the panel rather than selected in an editor. */
    translate(text: string): Promise<void>;
    speak(text: string, lang: string): Promise<void>;
    openInBrowser(text: string, from: string, to: string): Promise<void>;
}

/**
 * The translation view: a running transcript of what has been translated,
 * with a box to translate something that is not in any editor.
 *
 * It exists because a hover cannot be held open, cannot be scrolled back
 * through, and is not the extension's to begin with — VS Code hands the one
 * widget to every extension answering a position, which is how GitLens' commit
 * card ends up stacked in with a translation. A webview is the extension's
 * own surface, so nothing else can draw in it.
 */
export class TranslationPanel implements vscode.WebviewViewProvider {
    /**
     * The view is contributed twice, once per side bar, because a container is
     * placed by where it is declared and only one of the two declarations can
     * be live at a time. `panelLocation` picks which through a context key, so
     * both ids are registered and whichever the workbench resolves is the one
     * that gets drawn and focused.
     */
    public static readonly viewIds = [`${SECTION}.transcript`, `${SECTION}.transcriptBar`];

    private view: vscode.WebviewView | undefined;
    private history: HistoryEntry[];
    /** Source text of the request in flight, drawn as an unanswered bubble. */
    private waiting: string | undefined;
    private failure: string | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly host: PanelHost
    ) {
        this.history = context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []) ?? [];
    }

    /* ------------------------------------------------------------- view */

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage(message => void this.receive(message));
        view.onDidDispose(() => {
            // Moving side bars tears the old view down after the new one is
            // already up, so only the view still on screen may clear this.
            if (this.view === view) {
                this.view = undefined;
            }
        });
        this.post();
    }

    /** Brings the view up without stealing the editor's focus. */
    async reveal(): Promise<void> {
        // Only the container the context key allows has a focus command; the
        // other id is not registered, and asking for it throws.
        const known = this.view?.viewType;
        for (const id of known ? [known] : TranslationPanel.viewIds) {
            try {
                await vscode.commands.executeCommand(`${id}.focus`);
                return;
            } catch {
                // The other side bar holds the live one.
            }
        }
    }

    /* ------------------------------------------------------------ state */

    /**
     * Files an answered request.
     *
     * The same text answered again — the language pair changed, or the popup
     * was reopened — replaces the entry it repeats rather than stacking a
     * second copy of it under the first.
     */
    record(entry: Omit<HistoryEntry, 'at'>): void {
        const last = this.history[this.history.length - 1];
        const repeat = last && last.source === entry.source;
        const filed: HistoryEntry = { ...entry, at: Date.now() };

        if (repeat) {
            this.history[this.history.length - 1] = filed;
        } else {
            this.history.push(filed);
        }

        const cap = Math.max(1, vscode.workspace.getConfiguration(SECTION).get<number>('historySize', 50)!);
        if (this.history.length > cap) {
            this.history = this.history.slice(-cap);
        }

        this.waiting = undefined;
        this.failure = undefined;
        void this.context.globalState.update(HISTORY_KEY, this.history);
        this.post();
    }

    /** Draws `text` as asked-but-unanswered until record or fail arrives. */
    expect(text: string | undefined): void {
        this.waiting = text;
        if (text) {
            this.failure = undefined;
        }
        this.post();
    }

    fail(message: string): void {
        this.waiting = undefined;
        this.failure = message;
        this.post();
    }

    clear(): void {
        this.history = [];
        this.failure = undefined;
        void this.context.globalState.update(HISTORY_KEY, this.history);
        this.post();
    }

    /** Re-renders on a language change, so the header keeps up with the status bar. */
    refresh(): void {
        this.post();
    }

    private post(): void {
        const cfg = vscode.workspace.getConfiguration(SECTION);
        void this.view?.webview.postMessage({
            type: 'state',
            history: this.history.map(entry => ({ ...entry, fromName: languageName(entry.from) })),
            from: cfg.get<string>('sourceLanguage', 'auto'),
            fromName: languageName(cfg.get<string>('sourceLanguage', 'auto')!),
            to: cfg.get<string>('targetLanguage', 'vi'),
            toName: languageName(cfg.get<string>('targetLanguage', 'vi')!),
            waiting: this.waiting,
            failure: this.failure
        });
    }

    /* --------------------------------------------------------- messages */

    private async receive(message: { type: string; text?: string; at?: number }): Promise<void> {
        const entry = this.history.find(candidate => candidate.at === message.at);

        switch (message.type) {
            case 'ready':
                this.post();
                return;
            case 'translate':
                if (message.text?.trim()) {
                    await this.host.translate(message.text.trim());
                }
                return;
            case 'copy':
                if (entry) {
                    await vscode.env.clipboard.writeText(entry.translated);
                    vscode.window.setStatusBarMessage('$(check) Translation copied', 2000);
                }
                return;
            case 'speak':
                if (entry) {
                    await this.host.speak(entry.translated, entry.to);
                }
                return;
            case 'open':
                if (entry) {
                    await this.host.openInBrowser(entry.source, entry.from, entry.to);
                }
                return;
            case 'again':
                if (entry) {
                    await this.host.translate(entry.source);
                }
                return;
            case 'pickSource':
                await vscode.commands.executeCommand(`${SECTION}.pickSourceLanguage`);
                return;
            case 'pickTarget':
                await vscode.commands.executeCommand(`${SECTION}.pickTargetLanguage`);
                return;
            case 'swap':
                await vscode.commands.executeCommand(`${SECTION}.swapLanguages`);
                return;
            case 'settings':
                await vscode.commands.executeCommand(`${SECTION}.openSettings`);
                return;
            case 'clear':
                this.clear();
                return;
        }
    }

    /* ------------------------------------------------------------- html */

    private html(webview: vscode.Webview): string {
        const nonce = Array.from({ length: 32 }, () =>
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
                Math.floor(Math.random() * 62)
            )
        ).join('');

        // Every colour is a VS Code variable, so the transcript follows the
        // active theme the way the rest of the editor does.
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        height: 100vh;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
    }

    header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--vscode-panel-border);
        flex: none;
    }
    header .pair { display: flex; align-items: center; gap: 4px; min-width: 0; }
    header .spacer { flex: 1; }

    button {
        font: inherit;
        color: var(--vscode-foreground);
        background: none;
        border: 1px solid transparent;
        border-radius: 4px;
        padding: 2px 6px;
        cursor: pointer;
    }
    button:hover { background: var(--vscode-toolbar-hoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    button.lang { color: var(--vscode-textLink-foreground); padding: 2px 4px; }
    button.lang.target { font-weight: 600; }

    #log {
        flex: 1;
        overflow-y: auto;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 14px;
    }

    .turn { display: flex; flex-direction: column; gap: 6px; }
    .bubble {
        border-radius: 6px;
        padding: 7px 9px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        line-height: 1.5;
    }
    .source {
        background: var(--vscode-textBlockQuote-background);
        border-left: 2px solid var(--vscode-textBlockQuote-border);
        color: var(--vscode-descriptionForeground);
    }
    .result { background: var(--vscode-editor-inactiveSelectionBackground); }
    .error {
        background: var(--vscode-inputValidation-errorBackground);
        border: 1px solid var(--vscode-inputValidation-errorBorder);
    }

    .meta {
        display: flex;
        align-items: center;
        gap: 2px;
        font-size: 0.9em;
        color: var(--vscode-descriptionForeground);
    }
    .meta .spacer { flex: 1; }
    /* The row is quiet until the turn is pointed at, so a long transcript
       reads as text rather than as rows of controls. */
    .meta .tools { opacity: 0; transition: opacity 80ms linear; }
    .turn:hover .meta .tools, .meta .tools:focus-within { opacity: 1; }

    .empty {
        margin: auto;
        padding: 24px;
        text-align: center;
        color: var(--vscode-descriptionForeground);
        line-height: 1.6;
    }
    kbd {
        font-family: var(--vscode-editor-font-family);
        border: 1px solid var(--vscode-panel-border);
        border-bottom-width: 2px;
        border-radius: 3px;
        padding: 0 4px;
    }

    footer {
        flex: none;
        display: flex;
        gap: 6px;
        padding: 8px 10px;
        border-top: 1px solid var(--vscode-panel-border);
    }
    /* The two share a height so their boxes line up; the button keeps it as the
       box above grows, which anchors it to the last line being typed. */
    textarea, footer button.send { min-height: 30px; border-radius: 4px; }
    textarea {
        flex: 1;
        resize: none;
        font: inherit;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 5px 7px;
        max-height: 140px;
    }
    textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    footer button.send {
        flex: none;
        align-self: flex-end;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 12px;
        border-color: var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    footer button.send:hover { background: var(--vscode-button-hoverBackground); }

    .spin { display: inline-block; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
</head>
<body>
<header>
    <div class="pair">
        <button class="lang" id="from" title="Change source language"></button>
        <span>&rarr;</span>
        <button class="lang target" id="to" title="Change target language"></button>
        <button id="swap" title="Swap languages">&#8646;</button>
    </div>
    <span class="spacer"></span>
    <button id="clear" title="Clear history">Clear</button>
    <button id="settings" title="Extension options">&#9881;</button>
</header>

<div id="log"></div>

<footer>
    <textarea id="input" rows="1" placeholder="Type text to translate — Enter to send, Shift+Enter for a new line"></textarea>
    <button class="send" id="send">Translate</button>
</footer>

<script nonce="${nonce}">
(function () {
    const vscode = acquireVsCodeApi();
    const log = document.getElementById('log');
    const input = document.getElementById('input');

    const send = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));

    document.getElementById('from').onclick = () => send('pickSource');
    document.getElementById('to').onclick = () => send('pickTarget');
    document.getElementById('swap').onclick = () => send('swap');
    document.getElementById('clear').onclick = () => send('clear');
    document.getElementById('settings').onclick = () => send('settings');

    function submit() {
        const text = input.value.trim();
        if (!text) return;
        send('translate', { text });
        input.value = '';
        resize();
    }
    document.getElementById('send').onclick = submit;

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    });
    function resize() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    }
    input.addEventListener('input', resize);
    resize();

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function tool(label, title, onClick) {
        const button = el('button', undefined, label);
        button.title = title;
        button.onclick = onClick;
        return button;
    }

    function turn(entry) {
        const wrap = el('div', 'turn');
        wrap.appendChild(el('div', 'bubble source', entry.source));
        wrap.appendChild(el('div', 'bubble result', entry.translated));

        const meta = el('div', 'meta');
        meta.appendChild(el('span', undefined, entry.fromName + ' \\u2192 ' + entry.to));
        meta.appendChild(el('span', 'spacer'));

        const tools = el('span', 'tools');
        tools.appendChild(tool('Copy', 'Copy the translation', () => send('copy', { at: entry.at })));
        tools.appendChild(tool('\\uD83D\\uDD0A', 'Speak the translation', () => send('speak', { at: entry.at })));
        tools.appendChild(tool('\\u2197', 'Open on translate.google.com', () => send('open', { at: entry.at })));
        tools.appendChild(tool('\\u21BB', 'Translate again with the current languages', () => send('again', { at: entry.at })));
        meta.appendChild(tools);

        wrap.appendChild(meta);
        return wrap;
    }

    function render(state) {
        document.getElementById('from').textContent = state.from === 'auto' ? 'Detect' : state.fromName;
        document.getElementById('to').textContent = state.toName;

        // Whether the view was already pinned to the newest turn decides
        // whether it is scrolled again: a reader who has scrolled back is not
        // dragged to the bottom by someone else's translation finishing.
        const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

        log.textContent = '';

        if (!state.history.length && !state.waiting && !state.failure) {
            const empty = el('div', 'empty');
            empty.appendChild(el('div', 'Nothing translated yet.'));
            empty.appendChild(el('div', 'Select text in the editor and click the \\uD83C\\uDF10 marker, or type below.'));
            log.appendChild(empty);
            return;
        }

        state.history.forEach(entry => log.appendChild(turn(entry)));

        if (state.waiting) {
            const wrap = el('div', 'turn');
            wrap.appendChild(el('div', 'bubble source', state.waiting));
            const busy = el('div', 'bubble result');
            busy.appendChild(el('span', 'spin', '\\u25CC'));
            busy.appendChild(el('span', undefined, ' Translating\\u2026'));
            wrap.appendChild(busy);
            log.appendChild(wrap);
        }

        if (state.failure) {
            log.appendChild(el('div', 'bubble error', state.failure));
        }

        if (pinned) log.scrollTop = log.scrollHeight;
    }

    window.addEventListener('message', e => {
        if (e.data && e.data.type === 'state') render(e.data);
    });

    send('ready');
}());
</script>
</body>
</html>`;
    }
}
