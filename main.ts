import axios from "axios";

// Ref: https://pilotmoon.github.io/PopClip-Extensions/interfaces/PopClip.html
// Source: https://github.com/pilotmoon/PopClip-Extensions/blob/master/popclip.d.ts

interface PasteboardContent {
    'public.utf8-plain-text'?: string
    'public.html'?: string
    'public.rtf'?: string
}

interface Input {
    content: PasteboardContent
    // data: { emails: RangedStrings; nonHttpUrls: RangedStrings; paths: RangedStrings; urls: RangedStrings }
    html: string
    markdown: string
    matchedText: string
    rtf: string
    text: string
    xhtml: string
}

interface Context {
    hasFormatting: boolean
    canPaste: boolean
    canCopy: boolean
    canCut: boolean
    browserUrl: string
    browserTitle: string
    appName: string
    appIdentifier: string
}

interface Modifiers {
    /** Shift (⇧) key state. */
    shift: boolean
    /** Control (⌃) key state. */
    control: boolean
    /** Option (⌥) key state. */
    option: boolean
    /** Command (⌘) key state. */
    command: boolean
}

interface Options {
    apiType: "openai" | "azure"
    apiBase: string
    apiKey: string
    apiVersion: string
    model: string
    temperature: string

    reviseEnabled: boolean
    revisePrimaryLanguage: string
    reviseSecondaryLanguage: string
    polishEnabled: boolean
    polishPrimaryLanguage: string
    polishSecondaryLanguage: string
    translateEnabled: boolean
    translatePrimaryLanguage: string
    translateSecondaryLanguage: string
    summarizeEnabled: boolean
    summarizePrimaryLanguage: string
    summarizeSecondaryLanguage: string

    // prompts: string
}

interface PopClip {
    context: Context
    modifiers: Modifiers
    showSuccess(): void
    showFailure(): void
    showText(text: string, options?: { preview?: boolean }): void
    copyText(text: string): void
    pasteText(text: string, options?: { restore?: boolean }): void
}

// Ref: https://platform.openai.com/docs/api-reference/chat/create

interface Message {
    role: "user" | "system" | "assistant"
    content: string
}

interface APIRequestData {
    model: string
    messages: Array<Message>
    temperature?: number
    top_p?: number
}

interface APIResponse {
    data: {
        choices: [{
            message: Message
        }];
    }
}

type AllowedOneTimeActions = "revise" | "polish" | "translate" | "summarize"
type AllowedActions = "chat" | AllowedOneTimeActions

abstract class ChatGPTAction {
    abstract beforeRequest(popclip: PopClip, input: Input, options: Options, action: AllowedActions): { allow: boolean, reason?: string }
    abstract makeRequestData(popclip: PopClip, input: Input, options: Options, action: AllowedActions): APIRequestData | null
    processResponse(popclip: PopClip, resp: APIResponse): string {
        return resp.data.choices[0].message.content.trim()
    }
    onRequestError(popclip: PopClip, e: unknown) { }
    doCleanup(): void { }
}

const InactiveChatHistoryResetIntervalMs = 8 * 1000 * 60 // 8 minutes.
// const MaxChatHistoryLength = 50

class ChatHistory {
    readonly appIdentifier: string
    private _lastActiveAt: Date
    private _messages: Array<Message>

    constructor(appIdentifier: string) {
        this.appIdentifier = appIdentifier
        this._lastActiveAt = new Date()
        this._messages = []
    }

    isActive(): boolean {
        return new Date().getTime() - this._lastActiveAt.getTime() < InactiveChatHistoryResetIntervalMs
    }

    clear() {
        this._messages.length = 0
    }

    push(message: Message) {
        this._messages.push(message)
        this._lastActiveAt = new Date()
    }

    pop(): Message | undefined {
        return this._messages.pop()
    }

    get lastActiveAt(): Date {
        return this._lastActiveAt
    }

    get messages(): Array<Message> {
        return this._messages
    }
}

class ChatAction extends ChatGPTAction {
    // Chat histories grouped by application identify.
    private chatHistories: Map<string, ChatHistory>

    constructor() {
        super()
        this.chatHistories = new Map()
    }

    private getChatHistory(appIdentifier: string): ChatHistory {
        let chat = this.chatHistories.get(appIdentifier)
        if (!chat) {
            chat = new ChatHistory(appIdentifier)
            this.chatHistories.set(appIdentifier, chat)
        }
        return chat
    }

    doCleanup() {
        for (const [appid, chat] of this.chatHistories) {
            if (!chat.isActive()) {
                this.chatHistories.delete(appid)
            }
        }
    }

    beforeRequest(popclip: PopClip, input: Input, options: Options, action: AllowedActions): { allow: boolean, reason?: string } {
        if (popclip.modifiers.shift) {
            this.chatHistories.delete(popclip.context.appIdentifier)
            const text = `${popclip.context.appName}(${popclip.context.appIdentifier})'s chat history has been cleared`
            return { allow: false, reason: text }
        }
        return { allow: true }
    }

    makeRequestData(popclip: PopClip, input: Input, options: Options, action: AllowedActions): APIRequestData | null {
        if (action !== "chat") {
            return null
        }
        const chat = this.getChatHistory(popclip.context.appIdentifier)
        chat.push({ role: "user", content: input.text })
        return {
            model: options.model,
            messages: chat.messages,
            temperature: Number(options.temperature),
        }
    }

    onRequestError(popclip: PopClip, e: unknown) {
        const chat = this.getChatHistory(popclip.context.appIdentifier)
        chat.pop() // Pop out the user message.
    }

    processResponse(popclip: PopClip, resp: APIResponse): string {
        const chat = this.getChatHistory(popclip.context.appIdentifier)
        chat.push(resp.data.choices[0].message)
        return resp.data.choices[0].message.content.trim()
    }
}

class OneTimeAction extends ChatGPTAction {
    private getPrompt(action: AllowedOneTimeActions, language: string): string {
        switch (action) {
            case "revise":
                return `Please revise the text to make it clearer, more concise, and more coherent, and please list the changes and briefly explain why (IMPORTANT: reply with ${language} language).`
            case "polish":
                return `Please correct the grammar and polish the text while adhering as closely as possible to the original intent (IMPORTANT: reply with ${language} language).`
            case "translate":
                return `Please translate the text into ${language} and only provide me with the translated content without formating.`
            case "summarize":
                return `Please summarize the text briefly, making sure to include all the important points (IMPORTANT: reply with ${language} language).`
        }
    }

    beforeRequest(popclip: PopClip, input: Input, options: Options, action: AllowedActions): { allow: boolean, reason?: string } {
        return { allow: options[`${action}Enabled`] }
    }

    makeRequestData(popclip: PopClip, input: Input, options: Options, action: AllowedActions): APIRequestData | null {
        if (action === "chat") {
            return null
        }

        const language = popclip.modifiers.shift ? options[`${action}SecondaryLanguage`] : options[`${action}PrimaryLanguage`]
        const prompt = this.getPrompt(action as AllowedOneTimeActions, language)
        return {
            model: options.model,
            messages: [
                // { role: "system", content: "You are a professional multilingual assistant who will help me revise, polish, or translate texts. Please strictly follow user instructions." },
                {
                    role: "user", content: `${prompt}
The input text being used for this task is enclosed within triple quotation marks below the next line:

"""${input.text}"""`,
                },
            ],
            temperature: Number(options.temperature),
        }
    }
}

function makeClientOptions(options: Options): object {
    if (options.apiType === "openai") {
        return {
            "baseURL": options.apiBase,
            headers: { Authorization: `Bearer ${options.apiKey}` },
            timeout: 10000,
        }
    } else if (options.apiType === "azure") {
        // Ref: https://learn.microsoft.com/en-us/azure/ai-services/openai/reference#chat-completions
        return {
            "baseURL": options.apiBase,
            headers: { "api-key": `${options.apiKey}` },
            params: {
                "api-version": options.apiVersion,
            },
            timeout: 10000,
        }
    }
    throw new Error(`unsupported api type: ${options.apiType}`);
}

function isTerminalApplication(appName: string): boolean {
    return appName === "iTerm2" || appName === "Terminal"
}

const chatGPTActions: Map<AllowedActions, ChatAction | OneTimeAction> = new Map();

function doCleanup() {
    for (const [_, actionImpl] of chatGPTActions) {
        actionImpl.doCleanup()
    }
}

async function doAction(popclip: PopClip, input: Input, options: Options, action: AllowedActions) {
    doCleanup()

    const actionImpl = chatGPTActions.get(action)!
    const guard = actionImpl.beforeRequest(popclip, input, options, action)
    if (!guard.allow) {
        if (guard.reason) {
            popclip.showText(guard.reason)
            popclip.showSuccess()
        }
        return
    }

    const requestData = actionImpl.makeRequestData(popclip, input, options, action)!

    const openai = axios.create(makeClientOptions(options))
    try {
        const resp: APIResponse = await openai.post(
            "chat/completions", requestData
        )
        const result = actionImpl.processResponse(popclip, resp)

        if (popclip.context.canPaste) {
            let toBePasted = `\n\n${result}\n`
            if (!isTerminalApplication(popclip.context.appName) && popclip.context.canCopy) {
                // Prevent the original selected text from being replaced.
                toBePasted = `${input.text}\n\n${result}\n`
            }
            popclip.pasteText(toBePasted, { restore: true })
            popclip.showSuccess()
        } else {
            popclip.copyText(result)
            popclip.showText(result, { preview: true })
        }
    } catch (e) {
        actionImpl.onRequestError(popclip, e)

        // popclip.showFailure()
        popclip.showText(String(e))
    }
}

chatGPTActions.set("chat", new ChatAction())
chatGPTActions.set("revise", new OneTimeAction())
chatGPTActions.set("polish", new OneTimeAction())
chatGPTActions.set("translate", new OneTimeAction())
chatGPTActions.set("summarize", new OneTimeAction())

export const actions = [
    {
        title: "ChatGPTx: do what you want (click while holding shift(⇧) to force clear the history for this app)",
        // icon: "symbol:arrow.up.message.fill", // icon: "iconify:uil:edit",
        requirements: ["text"],
        code: async (input: Input, options: Options, context: Context) => doAction(popclip, input, options, "chat"),
    },
    {
        title: "ChatGPTx: revise text (click while holding shift(⇧) to use the secondary language)",
        icon: "symbol:r.square.fill", // icon: "iconify:uil:edit",
        requirements: ["text", "option-reviseEnabled=1"],
        code: async (input: Input, options: Options, context: Context) => doAction(popclip, input, options, "revise"),
    },
    {
        title: "ChatGPTx: polish text (click while holding shift(⇧) to use the secondary language)",
        icon: "symbol:p.square.fill", // icon: "iconify:lucide:stars",
        requirements: ["text", "option-polishEnabled=1"],
        code: async (input: Input, options: Options, context: Context) => doAction(popclip, input, options, "polish"),
    },
    {
        title: "ChatGPTx: translate text (click while holding shift(⇧) to use the secondary language)",
        icon: "symbol:t.square.fill", // icon: "iconify:system-uicons:translate",
        requirements: ["text", "option-translateEnabled=1"],
        code: async (input: Input, options: Options, context: Context) => doAction(popclip, input, options, "translate"),
    },
    {
        title: "ChatGPTx: summarize text (click while holding shift(⇧) to use the secondary language)",
        icon: "symbol:s.square.fill", // icon: "iconify:system-uicons:translate",
        requirements: ["text", "option-summarizeEnabled=1"],
        code: async (input: Input, options: Options, context: Context) => doAction(popclip, input, options, "summarize"),
    },
]
