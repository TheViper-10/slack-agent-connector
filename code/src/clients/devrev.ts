import type { Readable } from 'node:stream';

import axios, { type AxiosInstance } from 'axios';

export class DevRevClient {
  private readonly http: AxiosInstance;

  constructor(endpoint: string, token: string) {
    this.http = axios.create({
      baseURL: `${endpoint.replace(/\/$/, '')}/internal`,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
  }

  async get<T>(path: string, params: Record<string, unknown>, token?: string): Promise<T> {
    const response = await this.http.get<T>(path, {
      headers: token ? { Authorization: token } : undefined,
      params,
    });
    return response.data;
  }

  async post<T>(path: string, data: unknown, token?: string): Promise<T> {
    const response = await this.http.post<T>(path, data, {
      headers: token ? { Authorization: token } : undefined,
    });
    return response.data;
  }

  async download(url: string): Promise<Readable> {
    const response = await axios.get<Readable>(url, { responseType: 'stream' });
    return response.data;
  }
}
