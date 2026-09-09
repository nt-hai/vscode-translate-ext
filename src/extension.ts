import * as vscode from 'vscode';
import { LANGUAGES, Language, languageName } from './languages';
import { TranslationPanel } from './panel';
import { clearCache, isCached, translate, ttsUrl, webUrl } from './translate';

const SECTION = 'quickTranslate';

/** Which end of the selection the marker's glyph hangs off. */
type Side = 'before' | 'after';

const SIDES: readonly Side[] = ['before', 'after'];

/** The marker's paint, and the hourglass that stands in for it, one per side. */
let icons: Record<Side, vscode.TextEditorDecorationType>;
let loaders: Record<Side, vscode.TextEditorDecorationType>;
let statusBar: vscode.StatusBarItem;
let selectionTimer: NodeJS.Timeout | undefined;
/** An answered request: what was sent, what came back, and in which pair. */
interface Answered {
    source: string;
    translated: string;
    /** What the engine reported, which under `auto` is the language it detected. */
    from: string;
    to: string;
}

let lastResult: Answered | undefined;
let output: vscode.OutputChannel;
let panel: TranslationPanel | undefined;
let state: vscode.Memento | undefined;
let secrets: vscode.SecretStorage | undefined;

/**
 * The prepared text the user has explicitly asked to translate. Hovering a
 * selection is easy to do by accident and every miss is a billed request, so
 * nothing reaches the network until the marker's link is clicked — this holds
 * what that click approved.
 */
let armed: string | undefined;

/**
 * Text whose translation is in flight. The hover widget has no loading state of
 * its own, so the popup is shown twice: once carrying a spinner while this is
 * set, then again with the result.
 */
let pending: string | undefined;

/**
 * How long the spinner stays up once it has appeared. A fast answer would
 * otherwise replace it within a frame or two, which reads as a flicker rather
 * than as progress — so a short request waits out the remainder, and a slow one
 * is never held back.
 */
const MIN_SPINNER_MS = 200;


/**
 * The key lives in the OS keychain, not in settings.json: a plain setting is
 * carried off the machine by Settings Sync, and a workspace-level one lands in
 * .vscode/settings.json where it gets committed. The old setting is still read
 * once, so an existing config keeps working — see migrateApiKey.
 */
const API_KEY_SECRET = `${SECTION}.apiKey`;

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('Quick Translate');
    state = context.globalState;
    secrets = context.secrets;
    void migrateApiKey();

    icons = paint('🌐', true);

    // Shown in the marker's place while the request is out. The status bar
    // progress is easy to miss — this sits where the click just happened.
    loaders = paint('⏳');

    promoteHover();

    void applyPanelLocation();

    panel = new TranslationPanel(context, {
        translate: translateFreeText,
        speak: (text, lang) => speak(text, lang),
        openInBrowser: (text, from, to) => openInBrowser(text, from, to)
    });

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = `${SECTION}.pickTargetLanguage`;
    statusBar.tooltip = 'Quick Translate: click to change target language';
    updateStatusBar();

    context.subscriptions.push(
        output,
        ...SIDES.map(side => icons[side]),
        ...SIDES.map(side => loaders[side]),
        statusBar,
        new vscode.Disposable(() => hover?.dispose()),
        // One provider, both containers: only the side bar `panelLocation`
        // allows ever resolves, and the transcript is scrolled and the input
        // holds a draft, so neither may be torn down when the view is hidden.
        ...TranslationPanel.viewIds.map(id =>
            vscode.window.registerWebviewViewProvider(id, panel!, {
                webviewOptions: { retainContextWhenHidden: true }
            })
        ),
        vscode.window.onDidChangeTextEditorSelection(onSelectionChange),
        vscode.window.onDidChangeActiveTextEditor(() => {
            // Only the active editor is ever re-rendered, so the one just left
            // has to be cleaned up here or its marker stays for good.
            for (const other of vscode.window.visibleTextEditors) {
                if (other !== vscode.window.activeTextEditor) {
                    clearMarkers(other);
                }
            }
            scheduleDecoration();
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(SECTION)) {
                if (e.affectsConfiguration(`${SECTION}.panelLocation`)) {
                    void applyPanelLocation();
                }
                updateStatusBar();
                scheduleDecoration();
            }
        }),
        vscode.commands.registerCommand(`${SECTION}.translateSelection`, translateSelectionCommand),
        vscode.commands.registerCommand(`${SECTION}.pickTargetLanguage`, (code?: string) => pickLanguage('targetLanguage', code)),
        vscode.commands.registerCommand(`${SECTION}.pickSourceLanguage`, (code?: string) => pickLanguage('sourceLanguage', code)),
        vscode.commands.registerCommand(`${SECTION}.swapLanguages`, swapLanguages),
        vscode.commands.registerCommand(`${SECTION}.copyLastResult`, copyLastResult),
        vscode.commands.registerCommand(`${SECTION}.replaceSelection`, replaceSelectionCommand),
        vscode.commands.registerCommand(`${SECTION}.speak`, speak),
        vscode.commands.registerCommand(`${SECTION}.openInBrowser`, openInBrowser),
        vscode.commands.registerCommand(`${SECTION}.openSettings`, () =>
            vscode.commands.executeCommand('workbench.action.openSettings', SECTION)
        ),
        vscode.commands.registerCommand(`${SECTION}.setApiKey`, setApiKey),
        vscode.commands.registerCommand(`${SECTION}.clearApiKey`, clearApiKey),
        vscode.commands.registerCommand(`${SECTION}.showPanel`, () => panel?.reveal()),
        vscode.commands.registerCommand(`${SECTION}.clearHistory`, () => panel?.clear()),
        vscode.commands.registerCommand(`${SECTION}.clearCache`, () => {
            clearCache();
            vscode.window.showInformationMessage('Quick Translate: cache cleared.');
        })
    );

    scheduleDecoration();
}

export function deactivate(): void {
    if (selectionTimer) {
        clearTimeout(selectionTimer);
    }
}

/* --------------------------------------------------------------- api key */

async function getApiKey(): Promise<string | undefined> {
    return (await secrets?.get(API_KEY_SECRET)) || undefined;
}

/**
 * Moves a key left in settings.json into the keychain, once, then deletes the
 * plaintext copy from every scope it was written to.
 */
async function migrateApiKey(): Promise<void> {
    if (!secrets || (await secrets.get(API_KEY_SECRET))) {
        return;
    }

    const cfg = config();
    const found = cfg.inspect<string>('apiKey');
    const stale: [string | undefined, vscode.ConfigurationTarget][] = [
        [found?.globalValue, vscode.ConfigurationTarget.Global],
        [found?.workspaceValue, vscode.ConfigurationTarget.Workspace],
        [found?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
    ];

    const key = stale.find(([value]) => !!value)?.[0];
    if (!key) {
        return;
    }

    await secrets.store(API_KEY_SECRET, key);
    for (const [value, target] of stale) {
        if (value) {
            await cfg.update('apiKey', undefined, target);
        }
    }

    output.appendLine('[apiKey] moved out of settings.json into the OS keychain');
    void vscode.window.showInformationMessage(
        'Quick Translate: your API key was moved from settings.json into the OS keychain. ' +
            'Use "Translate: Set Google Cloud API Key" to change it.'
    );
}

async function setApiKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
        title: 'Google Cloud Translation API key',
        prompt: 'Stored in the OS keychain, never in settings.json. Leave empty to cancel.',
        password: true,
        ignoreFocusOut: true
    });
    if (!value) {
        return;
    }
    await secrets?.store(API_KEY_SECRET, value.trim());
    clearCache();
    vscode.window.showInformationMessage('Quick Translate: API key saved. The official API is now in use.');
}

async function clearApiKey(): Promise<void> {
    await secrets?.delete(API_KEY_SECRET);
    clearCache();
    vscode.window.showInformationMessage('Quick Translate: API key removed. Falling back to the free endpoint.');
}

/* ---------------------------------------------------------------- config */

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
}

function updateStatusBar(): void {
    const cfg = config();
    if (!cfg.get<boolean>('showStatusBar', true)) {
        statusBar.hide();
        return;
    }
    const from = cfg.get<string>('sourceLanguage', 'auto')!;
    const to = cfg.get<string>('targetLanguage', 'vi')!;
    statusBar.text = `$(globe) ${from} → ${to}`;
    statusBar.show();
    panel?.refresh();
}

/**
 * Publishes the side bar choice as a context key.
 *
 * The two view containers are declared against opposite values of it, which is
 * the only way an extension gets to say where a container lives: the location
 * comes from which contribution point it is declared under, so choosing means
 * declaring both and letting a `when` clause retire one.
 */
async function applyPanelLocation(): Promise<void> {
    const left = config().get<string>('panelLocation', 'secondary') === 'activitybar';
    await vscode.commands.executeCommand('setContext', `${SECTION}.leftSidebar`, left);
}

/** Where an answered request is shown. */
function resultTarget(cfg: vscode.WorkspaceConfiguration): 'popup' | 'panel' | 'both' {
    const configured = cfg.get<string>('showResultIn', 'popup');
    return configured === 'panel' || configured === 'both' ? configured : 'popup';
}

/**
 * Translates text typed into the panel.
 *
 * Nothing here touches an editor: the text never came from one, so there is no
 * selection to mark, no marker to swap for an hourglass and no popup to open.
 */
async function translateFreeText(text: string): Promise<void> {
    const cfg = config();
    const from = cfg.get<string>('sourceLanguage', 'auto')!;
    const to = cfg.get<string>('targetLanguage', 'vi')!;
    const apiKey = await getApiKey();

    armed = text;
    panel?.expect(text);
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Translating…' },
            () => translate({ text, from, to, apiKey, host: cfg.get<string>('proxy') || undefined })
        );
        lastResult = { source: text, translated: result.text, from: result.detectedSource, to };
        panel?.record(lastResult);
    } catch (err) {
        panel?.fail(err instanceof Error ? err.message : String(err));
    }
}

/* ------------------------------------------------------------ decoration */

/**
 * The selection the user last made by hand, per document.
 *
 * Stepping through Find matches re-selects on every hit, which would plant a
 * marker on each one. The event carries what caused it, so a selection is
 * recorded here only when it came from the mouse or the keyboard, and the
 * marker is drawn only while the current selection is still that one.
 *
 * Comparing selections rather than suppressing events is what keeps the popup
 * working: showPopup nudges the selection off and back programmatically, and
 * the restored range matches the recorded one again.
 */
const gestures = new Map<string, string>();

function onSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
    if (openedByClick(e)) {
        return;
    }

    const byHand =
        e.kind === vscode.TextEditorSelectionChangeKind.Mouse ||
        e.kind === vscode.TextEditorSelectionChangeKind.Keyboard;
    if (byHand) {
        gestures.set(e.textEditor.document.uri.toString(), selectionKey(e.textEditor));
    }

    const dragging = trackDrag(e);
    if (dragging) {
        // The selection is still growing under the pointer. A marker drawn now
        // would sit inside the range and jump on the next frame, so the drag
        // runs with nothing on screen and the marker lands once, at the end.
        for (const side of SIDES) {
            e.textEditor.setDecorations(icons[side], []);
        }
    }
    scheduleDecoration(e.textEditor, dragging);
}

/**
 * Where the last mouse-driven selection change of a document was anchored, and
 * when it arrived.
 */
const drags = new Map<string, { anchor: string; at: number }>();

/**
 * The longest gap allowed between two events of one drag. Anything slower is
 * read as a fresh gesture rather than a continuation of the previous one.
 */
const DRAG_GAP_MS = 400;

/**
 * True while the pointer looks to be dragging out a selection.
 *
 * VS Code reports no mouse-up (microsoft/vscode#46974), so the button's state
 * has to be inferred from the shape of the events: a drag is a run of Mouse
 * changes that keep the same anchor while the active end moves, and the release
 * is simply the moment that run stops. That makes the settle delay below the
 * only thing standing in for the button coming up — a mid-drag pause longer
 * than it shows the marker early, and the next movement hides it again.
 */
function trackDrag(e: vscode.TextEditorSelectionChangeEvent): boolean {
    const key = e.textEditor.document.uri.toString();
    if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
        drags.delete(key);
        return false;
    }
    const { anchor } = e.textEditor.selection;
    const at = Date.now();
    const previous = drags.get(key);
    drags.set(key, { anchor: `${anchor.line},${anchor.character}`, at });
    return (
        previous !== undefined &&
        previous.anchor === `${anchor.line},${anchor.character}` &&
        at - previous.at < DRAG_GAP_MS
    );
}

function selectionKey(editor: vscode.TextEditor): string {
    return keyOf(editor.selection);
}

function keyOf(range: vscode.Range): string {
    const { start, end } = range;
    return `${start.line},${start.character},${end.line},${end.character}`;
}

/**
 * Where the marker is drawn, while it is.
 *
 * Click mode has nothing to attach a handler to — a decoration is paint, not a
 * widget — so a click on it has to be recognised from the selection it leaves
 * behind, and that comparison needs the range it was last drawn for.
 */
let marker: { uri: string; selection: vscode.Selection; side: Side } | undefined;

/**
 * Turns a click on the marker into the popup, and reports whether it did.
 *
 * The click itself never arrives: decorations take no input, so what shows up
 * is only its side effect — the pointer landed in the gap beside the selection,
 * which drops the selection onto the position the marker occupies.
 */
function openedByClick(e: vscode.TextEditorSelectionChangeEvent): boolean {
    const at = marker;
    if (!at || byPointer(config()) || e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
        return false;
    }
    const editor = e.textEditor;
    const on =
        at.uri === editor.document.uri.toString() &&
        editor.selection.isEmpty &&
        inMarkerGap(at.selection, at.side, editor.selection.active);
    if (!on) {
        return false;
    }

    // The click landed in the gap beside the selection, so it took the
    // selection with it. Putting it back is what the rest of the flow reads,
    // and what madeByHand has to answer for, or the marker is taken down the
    // moment the popup goes up.
    gestures.set(at.uri, keyOf(at.selection));
    editor.selection = at.selection;

    const cfg = config();
    const text = readSelection(editor);
    if (!text) {
        return false;
    }

    if (needsApproval(text, cfg)) {
        // The gate is the marker's own popup, and it is where the request is
        // actually approved. In hover mode it opens by itself when the pointer
        // arrives; here the click is what asks for it.
        gateOpen = true;
        void showPopup(editor);
        return true;
    }

    // Nothing left to approve — a cached answer costs nothing, and switching
    // the confirmation off is a standing approval — so the click goes straight
    // through to the translation.
    const { start, end } = at.selection;
    const anchor: Anchor = {
        uri: at.uri,
        range: [start.line, start.character, end.line, end.character]
    };
    void vscode.commands.executeCommand(`${SECTION}.translateSelection`, anchor);
    return true;
}

/**
 * Set by a click on the marker, and spent by the next pass that draws it.
 *
 * Click mode leaves the marker bare so that resting the pointer on it opens
 * nothing; the gate is attached for one drawing only, the one that answers the
 * click, and the hover shown straight after it picks it up from there.
 */
let gateOpen = false;

/** True while the popup answers the pointer resting on the marker, not a click. */
function byPointer(cfg: vscode.WorkspaceConfiguration): boolean {
    return cfg.get<string>('popupTrigger', 'click') !== 'click';
}

function madeByHand(editor: vscode.TextEditor): boolean {
    return gestures.get(editor.document.uri.toString()) === selectionKey(editor);
}

function scheduleDecoration(editor = vscode.window.activeTextEditor, dragging = false): void {
    if (selectionTimer) {
        clearTimeout(selectionTimer);
    }
    if (!editor) {
        return;
    }
    const cfg = config();
    // A drag is waited out with its own delay: it is the stand-in for the mouse
    // button coming up, so it answers to how long a hand pauses mid-selection,
    // not to how long a settled selection should sit before being marked.
    const delay = dragging
        ? cfg.get<number>('dragSettleDelay', 250)!
        : cfg.get<number>('autoShowDelay', 350)!;
    selectionTimer = setTimeout(() => renderDecoration(editor), Math.max(0, delay));
}

function renderDecoration(editor: vscode.TextEditor): void {
    // A request in flight owns the marker's cell: whileLoading has the hourglass
    // standing there, and every exit below clears decorations on its way out —
    // including the one taken when showTextDocument has swapped the editor
    // object under a debounce scheduled before it. Any of them would strip the
    // hourglass mid-request. whileLoading takes it down itself when the work
    // settles, and the marker is redrawn on the pass after that.
    if (pending !== undefined) {
        marker = undefined;
        return;
    }

    if (editor !== vscode.window.activeTextEditor) {
        // Returning without clearing would strand the marker here, and with it
        // a gate still offering a selection this editor may no longer have.
        clearMarkers(editor);
        return;
    }
    const cfg = config();
    const selection = editor.selection;
    const text = selection.isEmpty ? '' : readSelection(editor);

    if (!cfg.get<boolean>('showIconOnSelect', true) || !text) {
        marker = undefined;
        for (const side of SIDES) {
            editor.setDecorations(icons[side], []);
        }
        return;
    }

    if (cfg.get<boolean>('manualSelectionOnly', true) && !madeByHand(editor)) {
        clearMarkers(editor);
        return;
    }

    // An automatic popup is a third way in, and it opens by itself; there is
    // nothing for it to do where the popup answers clicks only.
    const auto = byPointer(cfg) && cfg.get<boolean>('autoShowPopup', false);
    if (auto) {
        // Opting into an automatic popup is opting into the request behind it.
        armed = text;
    }

    // The icon is injected beside the selection. Its own hover is the gate, so
    // it is only attached while the text still needs approving, and in click
    // mode only for the one pass that answers a click on it.
    const asked = gateOpen;
    gateOpen = false;

    const side = markerSide(editor, selection, cfg);
    const range = markerRange(side, selection);
    marker = { uri: editor.document.uri.toString(), selection, side };
    editor.setDecorations(icons[side], [
        (byPointer(cfg) || asked) && needsApproval(text, cfg)
            ? { range, hoverMessage: gate(text, editor) }
            : { range }
    ]);
    // The selection before this one may have put the glyph on the other side.
    editor.setDecorations(icons[side === 'before' ? 'after' : 'before'], []);

    if (auto) {
        // The caret is wherever the gesture left it, which for a left-to-right
        // drag is the end the popup may have been moved away from.
        const settled = caretOn(popupSide(editor, selection, cfg), selection);
        if (!editor.selection.active.isEqual(settled.active)) {
            editor.selection = settled;
        }
        promoteHover();
        void vscode.commands.executeCommand('editor.action.showHover');
    }
}

function clearMarkers(editor: vscode.TextEditor): void {
    marker = undefined;
    for (const side of SIDES) {
        editor.setDecorations(icons[side], []);
        editor.setDecorations(loaders[side], []);
    }
}

/**
 * The marker's paint, one decoration type per side.
 *
 * The two are the same glyph with its padding mirrored, so it keeps its
 * distance from the text whichever end of the selection it ends up on.
 */
function paint(glyph: string, clickable = false): Record<Side, vscode.TextEditorDecorationType> {
    const build = (side: Side): vscode.TextEditorDecorationType => {
        const attachment: vscode.ThemableDecorationAttachmentRenderOptions = {
            contentText: side === 'before' ? `${glyph} ` : ` ${glyph}`,
            margin: side === 'before' ? '0 0.25em 0 0' : '0 0 0 0.25em',
            fontStyle: 'normal',
            // An attachment has no `cursor` of its own, but textDecoration is
            // passed through as raw CSS, so the pointer rides along with it.
            ...(clickable ? { textDecoration: 'none; cursor: pointer' } : {})
        };
        const options: vscode.DecorationRenderOptions = {
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            ...(clickable ? { cursor: 'pointer' } : {})
        };
        if (side === 'before') {
            options.before = attachment;
        } else {
            options.after = attachment;
        }
        return vscode.window.createTextEditorDecorationType(options);
    };
    return { before: build('before'), after: build('after') };
}

/**
 * Which end of the selection the marker hangs off.
 *
 * An `after` attachment on a selection that ends at end of line is not drawn
 * among the line's characters: VS Code moves it out into the strip past the
 * last one, which is the strip GitLens' blame, Error Lens and inline
 * suggestions write into as well. Nothing orders that strip for us, so the
 * glyph lands behind whatever else claimed it — pushed far out to the right, or
 * off screen entirely. Hanging it off the front of the selection instead puts
 * it back inside the line, where it has the space to itself.
 */
function markerSide(
    editor: vscode.TextEditor,
    range: vscode.Range,
    cfg: vscode.WorkspaceConfiguration
): Side {
    const configured = cfg.get<string>('iconPosition', 'auto');
    if (configured === 'before' || configured === 'after') {
        return configured;
    }
    return endsAtEol(editor, range) ? 'before' : 'after';
}

/** True where a range stops at the last character of its line. */
function endsAtEol(editor: vscode.TextEditor, range: vscode.Range): boolean {
    return range.end.character >= editor.document.lineAt(range.end.line).text.length;
}

/** The empty range a glyph on this side is attached to. */
function markerRange(side: Side, range: vscode.Range): vscode.Range {
    return side === 'before'
        ? new vscode.Range(range.start, range.start)
        : new vscode.Range(range.end, range.end);
}

/**
 * Which end of the selection the popup opens at.
 *
 * VS Code opens the hover widget at the leftmost column anything in it claims,
 * and never to the right of the caret — so this one answer decides both where
 * the caret is put before `editor.action.showHover` runs and what range
 * provideHover hands back. The two cannot disagree: a caret at the end with a
 * range at the start still opens the widget at the start.
 *
 * That is also what ties the popup's position to the blame card. The column
 * past the last character of a line is where GitLens answers a hover with its
 * commit details (`gitlens.hovers.currentLine.over: "annotation"`), and every
 * provider answering one position shares the single widget — so a popup asked
 * for at the end of a selection that runs to end of line opens with GitLens'
 * card on top of the translation. Under `auto` the popup steps back to the
 * front of the selection for exactly those selections; `end` keeps it where it
 * was asked for and takes the card.
 */
function popupSide(
    editor: vscode.TextEditor,
    range: vscode.Range,
    cfg: vscode.WorkspaceConfiguration
): Side {
    switch (cfg.get<string>('popupPosition', 'auto')) {
        case 'start':
            return 'before';
        case 'end':
            return 'after';
        default:
            return endsAtEol(editor, range) ? 'before' : 'after';
    }
}

/** The same selection, re-anchored so the caret rests on the given side. */
function caretOn(side: Side, selection: vscode.Selection): vscode.Selection {
    return side === 'before'
        ? new vscode.Selection(selection.end, selection.start)
        : new vscode.Selection(selection.start, selection.end);
}

/**
 * True where a position falls in the gap the glyph is painted in.
 *
 * It sits between two characters rather than on one, so either side of the gap
 * rounds to it, and a click or a hover on it can arrive as either.
 */
function inMarkerGap(range: vscode.Range, side: Side, position: vscode.Position): boolean {
    const glyph = side === 'before' ? range.start : range.end;
    const first = side === 'before' ? glyph.character - 1 : glyph.character;
    return (
        position.line === glyph.line &&
        position.character >= first &&
        position.character <= first + 1
    );
}

/** True while translating this text would cost a request the user has not asked for. */
function needsApproval(text: string, cfg: vscode.WorkspaceConfiguration): boolean {
    if (!cfg.get<boolean>('confirmBeforeTranslate', true) || armed === text) {
        return false;
    }
    // A cached answer costs nothing, so there is nothing to approve.
    return !isCached({
        text,
        from: cfg.get<string>('sourceLanguage', 'auto')!,
        to: cfg.get<string>('targetLanguage', 'vi')!
    });
}

interface Anchor {
    uri: string;
    range: [number, number, number, number];
}

/**
 * The popup shown on the marker before anything is sent. Clicking a link inside
 * a hover can drop the editor's selection, so the range travels with the
 * command rather than being read back off the editor when it runs.
 */
function gate(text: string, editor: vscode.TextEditor): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const { start, end } = editor.selection;
    const anchor: Anchor = {
        uri: editor.document.uri.toString(),
        range: [start.line, start.character, end.line, end.character]
    };

    const count = text.length === 1 ? '1 character' : `${text.length} characters`;
    md.appendMarkdown(
        `[$(globe) Translate ${count}](command:${SECTION}.translateSelection?${encodeURIComponent(
            JSON.stringify([anchor])
        )} "Send this selection to the translation engine")`
    );
    return md;
}

/* ----------------------------------------------------------------- hover */

/** The placeholder shown in the popup's place while the request is out. */
function buildSpinner(text: string, from: string, to: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;

    const configured = config().get<string>('sourceLanguage', 'auto')!;
    const label = configured === 'auto' ? 'Detecting…' : languageName(from);
    const count = text.length === 1 ? '1 character' : `${text.length} characters`;

    md.appendMarkdown(
        `$(globe) ${escapeMd(label)} $(arrow-right) **${escapeMd(languageName(to))}**\n\n` +
            `---\n\n` +
            `$(loading~spin) &nbsp; Translating ${count}…`
    );
    return md;
}

/** Collapses a range onto the end the popup opens at. */
function popupRange(range: vscode.Range, editor: vscode.TextEditor): vscode.Range {
    return markerRange(popupSide(editor, range, config()), range);
}

/**
 * What the hover provider answers for, and how highly it ranks.
 *
 * A hover widget is shared. VS Code asks every provider that answers the
 * position, stacks the replies into the one popup and orders them by how the
 * providers rank — selector score first, and among equal scores the most
 * recent registration. GitLens answers the column past the last character of a
 * line with its commit card, so a translation that ranks below it is stacked
 * underneath and pushed out of sight.
 *
 * The glob is what carries the score: an all-wildcard `{scheme, language}`
 * filter scores 5, a matching pattern scores 10 — which is what GitLens gets
 * from registering against the file's own path. It is paired with the wildcard
 * filter rather than replacing it so that a URI no glob can match still has a
 * provider, at the lower rank.
 */
const HOVER_SELECTOR: vscode.DocumentSelector = [{ scheme: '*', language: '*' }, { pattern: '**/*' }];

let hover: vscode.Disposable | undefined;

/**
 * Registers the hover provider again, making it the most recent one.
 *
 * Score only settles half the order; the rest is registration time, and
 * GitLens tears its line hover down and puts it back on every line change —
 * including the selection nudge this extension makes on its way to opening the
 * popup. Re-registering immediately before the popup is asked for is what
 * leaves the translation at the top of the widget.
 */
function promoteHover(): void {
    hover?.dispose();
    hover = vscode.languages.registerHoverProvider(HOVER_SELECTOR, { provideHover });
}

async function provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
): Promise<vscode.Hover | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document) {
        return undefined;
    }

    const cfg = config();
    let range: vscode.Range | undefined;

    const selection = editor.selections.find(
        s =>
            !s.isEmpty &&
            (s.contains(position) || inMarkerGap(s, markerSide(editor, s, cfg), position))
    );
    if (selection) {
        range = new vscode.Range(selection.start, selection.end);
    } else if (cfg.get<boolean>('hoverOnWord', false)) {
        range = document.getWordRangeAtPosition(position);
    }

    if (!range) {
        return undefined;
    }

    const raw = document.getText(range);
    const text = prepare(raw, cfg);
    if (!text) {
        return undefined;
    }

    // Click mode: the popup is the answer to a click on the marker, never to
    // the pointer coming to rest. The click arms the text on its way here, so
    // that — and the spinner for a request already running — is all this
    // serves; hoverOnWord has nothing to open through.
    if (!byPointer(cfg) && armed !== text && pending !== text) {
        return undefined;
    }

    // Hovering a word is an explicit opt-in of its own; a selection has to be
    // approved through the marker first, and the marker carries its own hover.
    if (selection && needsApproval(text, cfg)) {
        return undefined;
    }

    const from = cfg.get<string>('sourceLanguage', 'auto')!;
    const to = cfg.get<string>('targetLanguage', 'vi')!;

    if (pending === text) {
        return new vscode.Hover(buildSpinner(text, from, to), popupRange(range, editor));
    }

    output.appendLine(`[hover] ${from} -> ${to} :: ${text.slice(0, 60)}`);

    try {
        const result = await translate({
            text,
            from,
            to,
            apiKey: await getApiKey(),
            host: cfg.get<string>('proxy') || undefined
        });
        if (token.isCancellationRequested) {
            return undefined;
        }
        file({ source: text, translated: result.text, from: result.detectedSource, to });
        // VS Code places the popup at the start of the hover's range, which for
        // a whole selection means far above the marker the user just clicked.
        return new vscode.Hover(buildPopup(text, result.text, result.detectedSource, to), popupRange(range, editor));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`[${new Date().toISOString()}] ${message}`);
        const md = new vscode.MarkdownString(`$(error) **Translate failed** — ${escapeMd(message)}`);
        md.supportThemeIcons = true;
        return new vscode.Hover(md, popupRange(range, editor));
    }
}

/**
 * Builds the popup body, mirroring the Google Translate bubble layout.
 *
 * A hover sanitizes away `style`, `class` and `data-*`, so there is no way to
 * paint a real card: `---` is the only element VS Code stretches to the popup
 * edges (`.monaco-hover hr` has a negative horizontal margin), which makes it
 * the one primitive that reads as a section boundary. The layout leans on that
 * — a toolbar row of its own above each block, never icons inline with prose.
 */
function buildPopup(source: string, translated: string, from: string, to: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.supportHtml = true;

    const link = (command: string, args: unknown[]) =>
        `command:${SECTION}.${command}?${encodeURIComponent(JSON.stringify(args))}`;

    // Both language names are links that open their picker right from the popup.
    const configuredSource = config().get<string>('sourceLanguage', 'auto')!;
    const sourceLabel = configuredSource === 'auto' ? `${languageName(from)} (auto)` : languageName(from);

    md.appendMarkdown(
        `$(globe) [${escapeMd(sourceLabel)}](${link('pickSourceLanguage', [])} "Change source language") ` +
            `$(arrow-right) [**${escapeMd(languageName(to))}**](${link('pickTargetLanguage', [])} "Change target language") ` +
            `&nbsp; [$(arrow-swap)](${link('swapLanguages', [])} "Swap languages") ` +
            `[$(gear)](${link('openSettings', [])} "Extension options")\n\n`
    );

    md.appendMarkdown('---\n\n');

    md.appendMarkdown(
        section(
            [
                `[$(unmute)](${link('speak', [source, from])} "Listen to the original")`,
                `[$(link-external)](${link('openInBrowser', [source, from, to])} "Open in Google Translate")`
            ],
            source,
            false
        )
    );

    md.appendMarkdown('---\n\n');

    md.appendMarkdown(
        section(
            [
                `[$(unmute)](${link('speak', [translated, to])} "Listen to the translation")`,
                `[$(copy) Copy](${link('copyLastResult', [])} "Copy translation")`,
                `[$(replace-all) Replace](${link('replaceSelection', [])} "Replace selection with translation")`
            ],
            translated,
            true
        )
    );

    const quick = quickLanguageRow(to, link);
    if (quick) {
        md.appendMarkdown(`---\n\n${quick}`);
    }

    return md;
}

/**
 * One block of the bubble: its own toolbar row, then the text underneath.
 * Markdown turns a single newline into a mere space, and whether a two-space
 * hard break survives depends on how the hover renderer configures marked — an
 * explicit `<br>` does not. Emphasis is applied per line because it cannot span
 * a break.
 */
function section(actions: string[], text: string, bold: boolean): string {
    const toolbar = actions.join('&nbsp;&nbsp;&nbsp;');
    const chunks = chunkLines(text, config().get<boolean>('renderMarkdown', true));

    const parts = chunks.map(part =>
        part.table
            ? // Rows join with real newlines because a <br> is not a row break,
              // and no emphasis is applied because it would swallow the pipes.
              part.lines.map(escapeMdInline).join('\n')
            : part.lines
                  .map(line => (line === '' ? '&nbsp;' : bold ? `**${escapeMd(line)}**` : escapeMd(line)))
                  .join('<br>')
    );

    // A table has to begin a block of its own; prose stays tight to the toolbar.
    const gap = chunks[0]?.table ? '\n\n' : '<br>';
    return `${toolbar}${gap}${parts.join('\n\n')}\n\n`;
}

/** A run of lines that all render the same way. */
interface Chunk {
    table: boolean;
    lines: string[];
}

/**
 * Splits the text into table blocks and everything else.
 *
 * The two cannot share a joiner: Markdown reads a single newline as a space, so
 * prose joined that way loses the line breaks the translation just preserved,
 * while a table joined with `<br>` never becomes a table at all. Detecting per
 * block rather than per selection means a document holding both still renders
 * both correctly.
 */
function chunkLines(text: string, allowTables: boolean): Chunk[] {
    const chunks: Chunk[] = [];

    for (const line of text.split('\n')) {
        const table = allowTables && isTableRow(line);
        const last = chunks[chunks.length - 1];
        if (last && last.table === table) {
            last.lines.push(line);
        } else {
            chunks.push({ table, lines: [line] });
        }
    }

    // Pipes alone are not a table — Markdown needs the `| --- |` divider too.
    // Without one the rows would silently collapse into a single paragraph.
    for (const part of chunks) {
        if (part.table && !(part.lines.length >= 2 && part.lines.some(isTableDivider))) {
            part.table = false;
        }
    }

    return chunks.reduce<Chunk[]>((merged, part) => {
        const last = merged[merged.length - 1];
        if (last && last.table === part.table) {
            last.lines.push(...part.lines);
        } else {
            merged.push(part);
        }
        return merged;
    }, []);
}

function isTableRow(line: string): boolean {
    return /^\s*\|.*\|\s*$/.test(line);
}

function isTableDivider(line: string): boolean {
    return /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/.test(line);
}

/** One-click shortcuts to the languages the user switches between most. */
function quickLanguageRow(current: string, link: (c: string, a: unknown[]) => string): string {
    const codes = config().get<string[]>('quickLanguages', [])!;
    if (codes.length === 0) {
        return '';
    }

    const cells = codes.map(code =>
        code === current
            ? `**${escapeMd(code)}**`
            : `[${escapeMd(code)}](${link('pickTargetLanguage', [code])} "Translate to ${languageName(code)}")`
    );
    return `$(arrow-right) ${cells.join(' &nbsp;·&nbsp; ')}`;
}

/* -------------------------------------------------------------- commands */

async function translateSelectionCommand(anchor?: Anchor): Promise<void> {
    const editor = await editorFor(anchor);
    if (!editor) {
        return;
    }

    // Put back what the click dropped. Active goes to the end so the cursor —
    // and therefore the popup — lands on the marker rather than above the text.
    if (anchor) {
        const [startLine, startChar, endLine, endChar] = anchor.range;
        // The document may have been edited since the gate was drawn; clamping
        // keeps a now-out-of-bounds range from throwing.
        const range = editor.document.validateRange(
            new vscode.Range(startLine, startChar, endLine, endChar)
        );
        if (!range.isEmpty) {
            editor.selection = new vscode.Selection(range.start, range.end);
        }
    }

    if (editor.selection.isEmpty) {
        vscode.window.showInformationMessage(
            anchor
                ? 'Quick Translate: that selection is no longer there — select the text again.'
                : 'Quick Translate: select some text first.'
        );
        return;
    }

    // Reaching this command at all is the approval, whether it came from the
    // marker's link or the keybinding.
    armed = readSelection(editor);

    // Not just showHover: the gate answered this position with "no hover", and
    // VS Code caches that per position, so re-showing here replays the refusal.
    // reopenPopup nudges the selection, which is what invalidates it.
    await reopenPopup();
}

async function replaceSelectionCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('Quick Translate: select some text first.');
        return;
    }

    const cfg = config();
    const selection = editor.selection;
    const text = prepare(editor.document.getText(selection), cfg);
    if (!text) {
        return;
    }

    armed = text;
    const apiKey = await getApiKey();

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Translating…' },
            () =>
                translate({
                    text,
                    from: cfg.get<string>('sourceLanguage', 'auto')!,
                    to: cfg.get<string>('targetLanguage', 'vi')!,
                    apiKey,
                    host: cfg.get<string>('proxy') || undefined
                })
        );
        file({ source: text, translated: result.text, from: result.detectedSource, to: cfg.get<string>('targetLanguage', 'vi')! });
        await editor.edit(builder => builder.replace(selection, result.text));
    } catch (err) {
        vscode.window.showErrorMessage(`Quick Translate: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function copyLastResult(): Promise<void> {
    if (!lastResult) {
        vscode.window.showInformationMessage('Quick Translate: nothing translated yet.');
        return;
    }
    await vscode.env.clipboard.writeText(lastResult.translated);
    vscode.window.setStatusBarMessage('$(check) Translation copied', 2000);
}

async function speak(text?: string, lang?: string): Promise<void> {
    const value = text ?? lastResult?.translated;
    if (!value) {
        return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(ttsUrl(value, lang ?? config().get<string>('targetLanguage', 'vi')!)));
}

async function openInBrowser(text?: string, from?: string, to?: string): Promise<void> {
    const cfg = config();
    const value = text ?? lastResult?.source;
    if (!value) {
        return;
    }
    const url = webUrl(
        value,
        from ?? cfg.get<string>('sourceLanguage', 'auto')!,
        to ?? cfg.get<string>('targetLanguage', 'vi')!
    );
    await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function pickLanguage(key: 'targetLanguage' | 'sourceLanguage', code?: string): Promise<void> {
    const cfg = config();
    const current = cfg.get<string>(key)!;

    // A code passed straight from a popup shortcut skips the picker entirely.
    let chosen = typeof code === 'string' && code ? code : undefined;

    if (!chosen) {
        const recent = recentLanguages(key);
        const available = LANGUAGES.filter(l => key === 'sourceLanguage' || l.code !== 'auto');
        // Recently used first, so the two or three languages in daily rotation
        // are always one keystroke away.
        const ordered = [
            ...recent.map(c => available.find(l => l.code === c)).filter((l): l is Language => !!l),
            ...available.filter(l => !recent.includes(l.code))
        ];

        const picked = await vscode.window.showQuickPick(
            ordered.map(l => ({
                label: l.code === current ? `$(check) ${l.name}` : l.name,
                description: l.code,
                detail: recent.includes(l.code) && l.code !== current ? 'Recently used' : undefined
            })),
            {
                title: key === 'targetLanguage' ? 'Translate to…' : 'Translate from…',
                placeHolder: `Current: ${languageName(current)}`,
                matchOnDescription: true
            }
        );
        if (!picked) {
            return;
        }
        chosen = picked.description;
    }

    if (chosen !== current) {
        await cfg.update(key, chosen, vscode.ConfigurationTarget.Global);
        await rememberLanguage(key, chosen);
        updateStatusBar();
    }
    await reopenPopup();
}

/**
 * The editor a gate click belongs to.
 *
 * Clicking a link in a hover does not necessarily focus the editor underneath
 * it, so the active one can be a different document entirely — and the anchor
 * already names the document it was drawn for. Resolving through it, and
 * focusing that editor, also lets reopenPopup read the same one back out of
 * activeTextEditor.
 */
async function editorFor(anchor?: Anchor): Promise<vscode.TextEditor | undefined> {
    if (!anchor) {
        return vscode.window.activeTextEditor;
    }
    const match = vscode.window.visibleTextEditors.find(
        candidate => candidate.document.uri.toString() === anchor.uri
    );
    if (!match) {
        return vscode.window.activeTextEditor;
    }
    return vscode.window.showTextDocument(match.document, match.viewColumn, false);
}

/** Language codes the user picked recently, most recent first. */
function recentLanguages(key: string): string[] {
    return state?.get<string[]>(`recent.${key}`, []) ?? [];
}

async function rememberLanguage(key: string, code: string): Promise<void> {
    if (!state || code === 'auto') {
        return;
    }
    const next = [code, ...recentLanguages(key).filter(c => c !== code)].slice(0, 5);
    await state.update(`recent.${key}`, next);
}

/**
 * Clicking a link inside a hover dismisses it, so anything that changes the
 * translation has to put the popup back up afterwards.
 */
async function reopenPopup(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
        return;
    }

    // A pending debounce from the settings change would fire mid-reopen.
    if (selectionTimer) {
        clearTimeout(selectionTimer);
        selectionTimer = undefined;
    }

    await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);

    const cfg = config();
    const text = readSelection(editor);
    const warm =
        !text ||
        isCached({
            text,
            from: cfg.get<string>('sourceLanguage', 'auto')!,
            to: cfg.get<string>('targetLanguage', 'vi')!
        });

    // The request goes out first and the popup waits on it, so that the popup
    // paints the finished translation instead of asking provideHover to wait
    // with the widget already open.
    pending = text || undefined;
    const where = resultTarget(cfg);
    if (text) {
        panel?.expect(text);
    }
    const fetching = whileLoading(editor, () =>
        vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Translating…' },
            () => prefetch(editor)
        )
    );

    // Nothing to open, so nothing to race: the panel carries its own spinner
    // and is updated in place, which is the whole dance the popup needs.
    if (where === 'panel') {
        file(await fetching);
        pending = undefined;
        renderDecoration(editor);
        await panel?.reveal();
        return;
    }

    // Two ways to reach the answer without a spinner: it is already held, or it
    // arrives before the spinner would have earned its place. Both open one
    // popup and leave it up, which is the whole point of racing the request
    // rather than announcing it.
    let shownAt: number | undefined;
    if (!warm) {
        // The spinner is a second popup rather than a state of the first: the
        // hover cannot be updated in place, so showing progress means opening
        // the widget, tearing it down and opening it again around the answer.
        // Giving the request a head start lets everything that beats it open
        // once, with the translation already in it. At 0 the race is lost
        // before it starts and every request gets its spinner.
        const head = Math.max(0, cfg.get<number>('spinnerAfterDelay', 0)!);
        const beatTheSpinner = await Promise.race([
            fetching.then(() => true),
            delay(head).then(() => false)
        ]);
        if (!beatTheSpinner) {
            await showPopup(editor);
            // Timed from here, not from the click: showPopup itself takes a
            // moment, and what matters is how long it is actually on screen.
            shownAt = Date.now();
        }
    }

    file(await fetching);
    pending = undefined;

    if (shownAt !== undefined) {
        const remaining = MIN_SPINNER_MS - (Date.now() - shownAt);
        if (remaining > 0) {
            await delay(remaining);
        }
    }

    await showPopup(editor);
    if (where === 'both') {
        await panel?.reveal();
    }
}

/**
 * Records an answer as the most recent result and files it in the transcript.
 *
 * The panel keeps its history whichever surface the user reads the answer on —
 * only where it is *shown* follows `showResultIn`.
 */
function file(answered: Answered | undefined): void {
    if (!answered) {
        panel?.expect(undefined);
        return;
    }
    lastResult = answered;
    panel?.record(answered);
}

/**
 * Puts the hover back up.
 *
 * Re-showing a hover at the position it was just dismissed at hands back
 * whatever was computed there before — the previous language pair, or the
 * spinner. Dropping it and moving the cursor off the spot and back invalidates
 * that, the same thing the user was doing by hand when reselecting the text.
 */
async function showPopup(editor: vscode.TextEditor): Promise<void> {
    await vscode.commands.executeCommand('editor.action.hideHover');

    const selection = editor.selection;
    const settled = caretOn(popupSide(editor, selection, config()), selection);
    // Somewhere other than where the caret is about to land, so the refusal
    // cached for that position is dropped.
    const off = settled.active.isEqual(selection.end) ? selection.start : selection.end;
    editor.selection = new vscode.Selection(off, off);
    await delay(0);
    editor.selection = settled;

    // The nudge queued two more debounced passes; drop them so they cannot
    // re-trigger the hover once it is already up.
    if (selectionTimer) {
        clearTimeout(selectionTimer);
        selectionTimer = undefined;
    }

    renderDecoration(editor);
    promoteHover();
    await vscode.commands.executeCommand('editor.action.showHover');
}

/** Swaps the marker for an hourglass until the work settles. */
async function whileLoading<T>(editor: vscode.TextEditor, work: () => Thenable<T>): Promise<T> {
    const selection = editor.selection;
    const side = markerSide(editor, selection, config());
    const range = markerRange(side, selection);
    for (const other of SIDES) {
        editor.setDecorations(icons[other], []);
    }
    editor.setDecorations(loaders[side], [range]);
    try {
        return await work();
    } finally {
        // renderDecoration puts the marker back; this only clears the hourglass,
        // and it has to run even when the request failed.
        for (const other of SIDES) {
            editor.setDecorations(loaders[other], []);
        }
    }
}

/**
 * Warms the cache for the current selection and language pair, and hands the
 * answer back so the caller can file it without asking for it a second time.
 */
async function prefetch(editor: vscode.TextEditor): Promise<Answered | undefined> {
    const cfg = config();
    const text = prepare(editor.document.getText(editor.selection), cfg);
    if (!text) {
        return undefined;
    }
    // Switching languages on an open popup is a request for the new pair.
    armed = text;
    const to = cfg.get<string>('targetLanguage', 'vi')!;
    try {
        const result = await translate({
            text,
            from: cfg.get<string>('sourceLanguage', 'auto')!,
            to,
            apiKey: await getApiKey(),
            host: cfg.get<string>('proxy') || undefined
        });
        return { source: text, translated: result.text, from: result.detectedSource, to };
    } catch (err) {
        // The popup reports the failure through provideHover, which runs the
        // request again off the same cache; the panel has no second chance.
        panel?.fail(err instanceof Error ? err.message : String(err));
        return undefined;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function swapLanguages(): Promise<void> {
    const cfg = config();
    const from = cfg.get<string>('sourceLanguage', 'auto')!;
    const to = cfg.get<string>('targetLanguage', 'vi')!;
    // 'auto' has no direction to swap into, so fall back to what was detected.
    const newTarget = from === 'auto' ? lastResult?.from ?? 'en' : from;
    await cfg.update('sourceLanguage', to, vscode.ConfigurationTarget.Global);
    await cfg.update('targetLanguage', newTarget, vscode.ConfigurationTarget.Global);
    updateStatusBar();
    await reopenPopup();
}

/* --------------------------------------------------------------- helpers */

function readSelection(editor: vscode.TextEditor): string {
    return prepare(editor.document.getText(editor.selection), config());
}

/**
 * Turns a code selection into something worth sending: comment markers and
 * per-line indentation are dropped, and the line structure is kept, folded or
 * flattened depending on `preserveLineBreaks`.
 */
function prepare(raw: string, cfg: vscode.WorkspaceConfiguration): string {
    let text = raw;

    if (cfg.get<boolean>('stripCommentMarkers', true)) {
        text = text
            .replace(/\/\*+|\*+\/|<!--|-->/g, ' ')
            .split('\n')
            .map(line => line.replace(/^\s*(\/\/+|#+|\*+|--)\s?/, ''))
            .join('\n');
    }

    const lines = text.split('\n').map(line => line.trim());

    switch (cfg.get<string>('preserveLineBreaks', 'all')) {
        case 'off':
            text = lines.join(' ');
            break;
        case 'paragraph':
            // Hard-wrapped lines are folded back into one sentence; only the
            // blank lines between paragraphs survive.
            text = lines
                .join('\n')
                .split(/\n{2,}/)
                .map(paragraph => paragraph.split('\n').join(' ').trim())
                .filter(paragraph => paragraph !== '')
                .join('\n\n');
            break;
        default:
            // Every line stays a line; runs of blank lines collapse into one.
            text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
            break;
    }

    // Horizontal runs only — \s would eat the newlines just preserved above.
    return text.replace(/[^\S\n]{2,}/g, ' ').trim().slice(0, cfg.get<number>('maxLength', 2000)!);
}

function escapeMd(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, m => `\\${m}`);
}

/**
 * Escape for text that is allowed to render as Markdown.
 *
 * The popup is a trusted MarkdownString, where a `command:` link runs the
 * command when clicked — so text taken out of whatever file happens to be open
 * must not be able to build one. Only the characters that form a link or raw
 * HTML are escaped: `[` and `]` break `[label](command:…)` and its reference
 * form, `<` and `>` break `<a href="command:…">`. Nothing else in Markdown
 * reaches a command, and GFM autolinking only ever matches http, ftp and
 * mailto, so `|`, `-`, `#`, `*`, `_` and backticks are left to do their job.
 */
function escapeMdInline(text: string): string {
    return text.replace(/[[\]<>]/g, m => `\\${m}`);
}
