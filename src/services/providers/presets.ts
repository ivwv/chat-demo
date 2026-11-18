import type { ModelConfig, ProviderDraft } from './types.js'

/** 内置服务商预设：只作为新建时的初始值，全部字段都可以在界面里改 */
export type ProviderPreset = {
  key: string
  /** 预设显示名，新建时作为服务商名称的初值 */
  name: string
  /** 分组，用于「添加服务商」下拉里的归类 */
  group: string
  draft: ProviderDraft
}

const model = (id: string, label = id): ModelConfig => ({ id, label })

/** 各家的默认模型只是起点，界面上可以「从服务商拉取」或手动增删 */
export const providerPresets: ProviderPreset[] = [
  {
    key: 'deepseek-anthropic',
    name: 'DeepSeek',
    group: 'DeepSeek',
    draft: {
      name: 'DeepSeek',
      protocol: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic/v1',
      // 兼容端点没有 /anthropic/v1/models，沿用官方 /models
      modelsUrl: 'https://api.deepseek.com/models',
      apiKey: '',
      models: [model('deepseek-flash'), model('deepseek-v4-pro')],
      features: {
        speech: true,
        serverTools: true,
        serverTitle: true,
        latestReminder: true,
        safetyCheck: true,
        filesApi: true,
      },
    },
  },
  {
    key: 'deepseek-openai',
    name: 'DeepSeek（OpenAI 兼容）',
    group: 'DeepSeek',
    draft: {
      name: 'DeepSeek（OpenAI 兼容）',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      models: [model('deepseek-chat'), model('deepseek-reasoner')],
    },
  },
  {
    key: 'openai',
    name: 'OpenAI',
    group: '国外服务商',
    draft: {
      name: 'OpenAI',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      models: [model('gpt-4o'), model('gpt-4o-mini'), model('gpt-4.1'), model('o4-mini')],
    },
  },
  {
    key: 'anthropic',
    name: 'Anthropic',
    group: '国外服务商',
    draft: {
      name: 'Anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: '',
      models: [model('claude-sonnet-4-5'), model('claude-opus-4-1'), model('claude-3-5-haiku-latest')],
    },
  },
  {
    key: 'gemini',
    name: 'Google Gemini',
    group: '国外服务商',
    draft: {
      name: 'Google Gemini',
      protocol: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: '',
      models: [model('gemini-2.5-pro'), model('gemini-2.5-flash')],
    },
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    group: '聚合平台',
    draft: {
      name: 'OpenRouter',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      models: [
        model('openai/gpt-4o-mini'),
        model('anthropic/claude-sonnet-4.5'),
        model('google/gemini-2.5-flash'),
        model('deepseek/deepseek-chat'),
      ],
    },
  },
  {
    key: 'siliconflow',
    name: '硅基流动',
    group: '国内服务商',
    draft: {
      name: '硅基流动',
      protocol: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: '',
      models: [
        model('deepseek-ai/DeepSeek-V3'),
        model('Qwen/Qwen2.5-72B-Instruct'),
        model('Qwen/Qwen2.5-VL-72B-Instruct'),
      ],
    },
  },
  {
    key: 'moonshot',
    name: '月之暗面 Kimi',
    group: '国内服务商',
    draft: {
      name: '月之暗面 Kimi',
      protocol: 'openai',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: '',
      models: [model('moonshot-v1-8k'), model('kimi-latest')],
    },
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    group: '国内服务商',
    draft: {
      name: '智谱 GLM',
      protocol: 'openai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: '',
      models: [model('glm-4-plus'), model('glm-4-flash'), model('glm-z1-air')],
    },
  },
  {
    key: 'dashscope',
    name: '阿里云百炼',
    group: '国内服务商',
    draft: {
      name: '阿里云百炼',
      protocol: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: '',
      models: [model('qwen-plus'), model('qwen-max'), model('qwen-vl-max')],
    },
  },
  {
    key: 'groq',
    name: 'Groq',
    group: '国外服务商',
    draft: {
      name: 'Groq',
      protocol: 'openai',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: '',
      models: [model('llama-3.3-70b-versatile'), model('llama-3.1-8b-instant')],
    },
  },
  {
    key: 'ollama',
    name: 'Ollama（本地）',
    group: '本地 / 自建',
    draft: {
      name: 'Ollama',
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      models: [model('qwen2.5'), model('llama3.2')],
    },
  },
  {
    key: 'custom-openai',
    name: '自定义（OpenAI 兼容）',
    group: '自定义',
    draft: {
      name: '自定义服务商',
      protocol: 'openai',
      baseUrl: '',
      apiKey: '',
      models: [],
    },
  },
  {
    key: 'custom-anthropic',
    name: '自定义（Anthropic 兼容）',
    group: '自定义',
    draft: {
      name: '自定义服务商',
      protocol: 'anthropic',
      baseUrl: '',
      apiKey: '',
      models: [],
    },
  },
]

/** 旧版本只存了一个 API Key，迁移时用它创建 DeepSeek 服务商 */
export const createDefaultProvider = (apiKey: string): ProviderDraft => ({
  ...providerPresets[0].draft,
  apiKey,
  models: providerPresets[0].draft.models.map((item) => ({ ...item })),
})
