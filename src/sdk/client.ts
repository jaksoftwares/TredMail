export interface TredMailConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface SendEmailOptions {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
  attachments?: Array<{
    filename: string;
    content: string; // base64 encoded
    contentType?: string;
  }>;
}

export interface SendEmailResponse {
  id: string;
  from: string;
  to: string[];
  status: string;
  created_at: string;
}

export class TredMail {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: TredMailConfig) {
    if (!config.apiKey) {
      throw new Error("TredMail API key is required. Pass { apiKey: 'tred_live_...' }");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "http://localhost:3000/v1";
  }

  public emails = {
    send: async (options: SendEmailOptions): Promise<{ data?: SendEmailResponse; error?: any }> => {
      try {
        const response = await fetch(`${this.baseUrl}/emails`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            from: options.from,
            to: options.to,
            cc: options.cc,
            bcc: options.bcc,
            reply_to: options.replyTo,
            subject: options.subject,
            html: options.html,
            text: options.text,
            headers: options.headers,
            tags: options.tags,
            attachments: options.attachments,
          }),
        });

        const json = await response.json();
        if (!response.ok) {
          return { error: json };
        }
        return { data: json as SendEmailResponse };
      } catch (err: any) {
        return { error: { message: err.message } };
      }
    },

    get: async (id: string) => {
      const response = await fetch(`${this.baseUrl}/emails/${id}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return await response.json();
    },
  };

  public domains = {
    list: async () => {
      const response = await fetch(`${this.baseUrl}/domains`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return await response.json();
    },

    create: async (name: string, region?: string) => {
      const response = await fetch(`${this.baseUrl}/domains`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ name, region }),
      });
      return await response.json();
    },

    verify: async (id: string) => {
      const response = await fetch(`${this.baseUrl}/domains/${id}/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return await response.json();
    },
  };
}
