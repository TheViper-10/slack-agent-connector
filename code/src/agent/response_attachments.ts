import type { Readable } from 'node:stream';

import type { WebClient } from '@slack/web-api';

import type { DevRevClient } from '../clients/devrev';
import { MAX_SLACK_ATTACHMENTS } from './constants';

export interface ArtifactSummary {
  file?: {
    name?: string;
    size?: number;
    type?: string;
  };
  headers?: {
    content_disposition?: string;
  };
  id: string;
}

interface ArtifactLocateResponse {
  url?: string;
}

interface SlackUploadedFile {
  name?: string;
  permalink?: string;
}

interface SlackUploadResponse {
  files?: Array<{ files?: SlackUploadedFile[] }>;
}

const uploadedFilesFromResponse = (response: SlackUploadResponse): SlackUploadedFile[] =>
  (response.files ?? []).flatMap((item) => item.files ?? []);

const loadArtifactSummary = async (devrev: DevRevClient, id: string): Promise<ArtifactSummary | undefined> => {
  try {
    const response = await devrev.get<{ artifact?: ArtifactSummary }>('artifacts.get', { id });
    return response.artifact;
  } catch {
    console.warn('Failed to get DevRev artifact metadata');
    return undefined;
  }
};

export const appendDevRevArtifactsForSlack = async (
  text: string,
  artifacts: ArtifactSummary[] | undefined,
  artifactIds: string[] | undefined,
  devrev: DevRevClient,
  slack: WebClient
): Promise<string> => {
  const summaries = [...(artifacts ?? [])].slice(0, MAX_SLACK_ATTACHMENTS);
  for (const id of artifactIds ?? []) {
    if (summaries.length >= MAX_SLACK_ATTACHMENTS) break;
    if (summaries.some((artifact) => artifact.id === id)) continue;
    const artifact = await loadArtifactSummary(devrev, id);
    if (artifact) summaries.push(artifact);
  }
  if (summaries.length === 0) return text;

  const downloads: Array<{ file: Readable; filename: string }> = [];
  for (const artifact of summaries) {
    const filename = artifact.file?.name;
    if (!filename) continue;
    try {
      const located = await devrev.get<ArtifactLocateResponse>('artifacts.locate', {
        id: artifact.id,
        prefer_download: true,
      });
      if (!located.url) continue;
      downloads.push({ file: await devrev.download(located.url), filename });
    } catch {
      console.warn('Failed to download a DevRev artifact for Slack');
    }
  }
  if (downloads.length === 0) return text;

  try {
    const response = (await slack.files.uploadV2({ file_uploads: downloads })) as SlackUploadResponse;
    const links = uploadedFilesFromResponse(response)
      .filter(
        (file): file is Required<Pick<SlackUploadedFile, 'name' | 'permalink'>> => !!file.name && !!file.permalink
      )
      .map((file) => `[${file.name}](${file.permalink})`);
    return [text, ...links].filter(Boolean).join('\n');
  } catch {
    console.warn('Failed to upload DevRev artifacts to Slack');
    return text;
  }
};
