// @ts-nocheck
import axios from "axios";

interface Message {
  role: "user" | "system" | "assistant"
  content: string
}

interface Response {
  data: {
    choices: [{
      message: Message
    }];
  }
}

type AllowedActions = "chat" | "revise" | "polish" | "translate"

const defaultPrompts: ReadonlyMap<string, string> = new Map(Object.entries({
  "revise": "Please revise the text to make it clearer, more concise, and more coherent, and please list the changes and briefly explain why (NOTE: do not translate the content).",
  "polish": "Please correct the grammar and polish the text while adhering as closely as possible to the original intent (NOTE: do not translate the content).",
  "translate": "Please translate the text into Chinese and only provide me with the translated content without formating.",
}))

function getPrompt(action: AllowedActions, customPrompts: string): string {
  if (customPrompts !== "") {
    const prompts = customPrompts.split("\n")
    for (let i = 0; i < prompts.length; i++) {
      const parts = prompts[i].trim().split("]")
      if (parts[0].substring(1) == action) {
        return parts.slice(1).join("]")
      }
    }
  }
  return defaultPrompts.get(action) || ""
}

function constructClientOptions(options: Options): object {
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

// Doc: https://pilotmoon.github.io/PopClip-Extensions/interfaces/Input.html
// Source: https://github.com/pilotmoon/PopClip-Extensions/blob/master/popclip.d.ts
interface Input {
  // content: PasteboardContent
  // data: { emails: RangedStrings; nonHttpUrls: RangedStrings; paths: RangedStrings; urls: RangedStrings }
  html: string
  markdown: string
  matchedText: string
  rtf: string
  text: string
  xhtml: string
}

interface Options {
  apiType: "openai" | "azure"
  apiBase: string
  apiKey: string
  apiVersion: string
  model: string
  revise: boolean
  polish: boolean
  translate: boolean
  prompts: string
}

async function chat(input: Input, options: Options, action: AllowedActions) {
  if (!options[action]) {
    popclip.showText(`action disabled: ${action}`);
    return
  }
  const prompt = getPrompt(action, options.prompts)

  const openai = axios.create(constructClientOptions(options))
  try {
    const { data }: Response = await openai.post(
      "chat/completions",
      {
        model: options.model,
        messages: [
          // { role: "system", content: "You are a professional multilingual assistant who will help me revise, polish, or translate texts. Please strictly follow user instructions." },
          {
            role: "user", content: `${prompt}
The input text being used for this task is enclosed within triple quotation marks below the next line:

"""${input.text}"""`
          },
        ],
      },
    )
    const answer = data.choices[0].message.content.trim()

    // Ref: https://pilotmoon.github.io/PopClip-Extensions/interfaces/PopClip.html
    if (popclip.context.canPaste) { // Ref: https://pilotmoon.github.io/PopClip-Extensions/interfaces/Context.html
      let toBePasted = `\n\n${answer}\n`
      if (!isTerminalApplication(popclip.context.appName) && popclip.context.canCopy) {
        // Prevent the original selected text from being replaced.
        toBePasted = `${input.text}\n\n${answer}\n`
      }
      popclip.pasteText(toBePasted, { restore: true })
      popclip.showSuccess()
    } else {
      popclip.copyText(answer)
      popclip.showText(answer, { preview: true })
    }
  } catch (e) {
    popclip.showFailure()
    popclip.showText(String(e))
  }
}

export const actions = [
  {
    title: "ChatGPTx: revise text",
    icon: "symbol:r.square.fill", // icon: "iconify:uil:edit",
    requirements: ["text", "option-revise=1"],
    code: async (input: Input, options: Options) => chat(input, options, "revise"),
  },
  {
    title: "ChatGPTx: polish text",
    icon: "symbol:p.square.fill", // icon: "iconify:lucide:stars",
    requirements: ["text", "option-polish=1"],
    code: async (input: Input, options: Options) => chat(input, options, "polish"),
  },
  {
    title: "ChatGPTx: translate text",
    icon: "symbol:t.square.fill", // icon: "iconify:system-uicons:translate",
    requirements: ["text", "option-translate=1"],
    code: async (input: Input, options: Options) => chat(input, options, "translate"),
  },
]
