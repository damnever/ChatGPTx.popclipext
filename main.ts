import axios from "axios";

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

const InactiveChatHistoryResetIntervalMs = 20 * 1000 * 60 // 20 minutes.
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
        return `Please revise the text for improved clarity, brevity, and coherence. List the changes made and provide a brief explanation for each (IMPORTANT: reply with ${language} language).`
      case "polish":
        return `Please correct any grammatical errors and enhance the text while maintaining the original intent and tone as closely as possible (IMPORTANT: reply with ${language} language).`
      case "translate":
        return `Please translate the text into ${language} and only provide me with the translated content without formating.`
      case "summarize":
        return `Please provide a concise summary of the text, ensuring that all significant points are included (IMPORTANT: reply with ${language} language).`
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
  const timeoutMs = 35000;
  const url = new URL(options.apiBase);
  const apiVersion = url.searchParams.get("api-version");
  const baseURL = url.origin + url.pathname.replace(/\/chat\/completions$/, "");

  if (options.apiType === "openai") {
    return {
      baseURL: baseURL,
      headers: { Authorization: `Bearer ${options.apiKey}` },
      timeout: timeoutMs,
    };
  } else if (options.apiType === "azure") {
    return {
      baseURL: baseURL,
      headers: { "api-key": `${options.apiKey}` },
      params: {
        "api-version": apiVersion,
      },
      timeout: timeoutMs,
    };
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

    if (!popclip.modifiers.option && popclip.context.canPaste) {
      let toBePasted = `\n\n${result}\n`
      if (!isTerminalApplication(popclip.context.appName) && popclip.context.canCopy) {
        // Prevent the original selected text from being replaced.
        toBePasted = `${input.text}\n\n${result}\n`
      }
      popclip.pasteText(toBePasted, { restore: true })
      popclip.showSuccess()
    } else {
      popclip.copyText(result, { notify: true })
      popclip.showText(result, { style: "compact", preview: true })
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

// Dynamic options:
//
// Prompt to list languages:
//   list top 100 languages that you can understand and generate texts in,
//   remove all dialects, such as Chinese dialects(but do include "Chinese Simplified" and "Chinese Traditional" ),
//   reply in JSON format using both English and their corresponding native language, e.g. [{"english": "Chinese Simplified", "native": "简体中文"}].
//
//   Please double check and count by yourself first.
//
// (Unfortunately, ChatGPT is unable to list 100 languages and I am exhausted from trying to make it accurate..)
import * as languages from "./top-languages-from-chatgpt.json"
const optionLanguagesValues: Array<string> = new Array()
const optionLanguagesValueLabels: Array<string> = new Array()

languages.sort((a, b) => {
  if (a.english < b.english) {
    return -1
  } else if (a.english > b.english) {
    return 1
  }
  return 0
}).forEach((value) => {
  optionLanguagesValues.push(value.english)
  optionLanguagesValueLabels.push(value.native)
})

const chatGPTActionsOptions: Array<any> = [
  {
    "identifier": "apiType",
    "label": "API Type",
    "type": "multiple",
    "default value": "openai",
    "values": [
      "openai",
      "azure"
    ]
  },
  {
    "identifier": "apiBase",
    "label": "API Base URL",
    "description": "For Azure: https://{resource-name}.openai.azure.com/openai/deployments/{deployment-id}?api-version={api-version}",
    "type": "string",
    "default value": "https://api.openai.com/v1"
  },
  {
    "identifier": "apiKey",
    "label": "API Key",
    "type": "string",
  },
  {
    "identifier": "model",
    "label": "Model",
    "type": "string",
    "default value": "gpt-3.5-turbo"
  },
  {
    "identifier": "temperature",
    "label": "Sampling Temperature",
    "type": "string",
    "description": ">=0, <=2. Higher values will result in a more random output, and vice versa.",
    "default value": "1"
  },
  {
    "identifier": "opinionedActions",
    "label": "NOTE",
    "type": "heading",
    "description": "Click while holding option(⌥) to force a preview instead of trying to paste first.",
  },
  {
    "identifier": "opinionedActions",
    "label": "❤ OPINIONED ACTIONS",
    "type": "heading",
    "description": "Click while holding shift(⇧) to use the secondary language.",
  }
]

new Array(
  { name: "revise", primary: "English", secondary: "Chinese Simplified" },
  { name: "polish", primary: "English", secondary: "Chinese Simplified" },
  { name: "translate", primary: "Chinese Simplified", secondary: "English" },
  { name: "summarize", primary: "Chinese Simplified", secondary: "English" },
).forEach((value) => {
  const capitalizedName = value.name.charAt(0).toUpperCase() + value.name.slice(1)
  chatGPTActionsOptions.push(
    {
      "identifier": value.name,
      "label": `${capitalizedName} Texts`,
      "type": "heading"
    },
    {
      "identifier": `${value.name}Enabled`,
      "label": "Enable",
      "type": "boolean",
      "inset": true
    },
    {
      "identifier": `${value.name}PrimaryLanguage`,
      "label": "Primary",
      "type": "multiple",
      "default value": `${value.primary}`,
      "values": optionLanguagesValues,
      "value labels": optionLanguagesValueLabels,
      "inset": true
    },
    {
      "identifier": `${value.name}SecondaryLanguage`,
      "label": "Secondary",
      "type": "multiple",
      "default value": `${value.secondary}`,
      "values": optionLanguagesValues,
      "value labels": optionLanguagesValueLabels,
      "inset": true
    })
})

export const options = chatGPTActionsOptions
