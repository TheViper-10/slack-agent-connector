import type { Readable } from 'node:stream';

import axios from 'axios';
import FormData from 'form-data';

import type { DevRevClient } from '../clients/devrev';
import { MAX_SLACK_ATTACHMENTS } from './constants';
import type { SlackAttachment } from './message';

const MAX_ATTACHMENT_BYTES = 250 * 1024 * 1024;

interface PreparedArtifact {
  form_data: Array<{ key: string; value: string }>;
  id: string;
  url: string;
}

interface ArtifactsPrepareRequest {
  configuration_set: 'default';
  file_name: string;
  file_type?: string;
}

const assertSlackFileUrl = (value: string): void => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com') {
    throw new Error('Unexpected Slack file URL');
  }
};

const uploadSlackAttachment = async (
  devrev: DevRevClient,
  attachment: SlackAttachment,
  slackToken: string,
  devrevToken: string
): Promise<string> => {
  if (attachment.size && attachment.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('Slack attachment exceeds the 250 MB upload limit');
  }
  assertSlackFileUrl(attachment.url);
  const download = await axios.get<Readable>(attachment.url, {
    headers: { Authorization: `Bearer ${slackToken}` },
    responseType: 'stream',
  });
  const prepareBody: ArtifactsPrepareRequest = {
    configuration_set: 'default',
    file_name: attachment.name,
  };
  if (attachment.mimetype) prepareBody['file_type'] = attachment.mimetype;
  const prepared = await devrev.post<PreparedArtifact>('artifacts.prepare', prepareBody, devrevToken);
  if (!prepared.id || !prepared.url || !Array.isArray(prepared.form_data)) {
    throw new Error('artifacts.prepare returned an unexpected response');
  }

  const form = new FormData();
  for (const field of prepared.form_data) form.append(field.key, field.value);
  form.append('file', download.data, {
    contentType: attachment.mimetype,
    filename: attachment.name,
    knownLength: attachment.size,
  });
  await axios.post(prepared.url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return prepared.id;
};

export const uploadSlackAttachments = async (
  devrev: DevRevClient,
  attachments: SlackAttachment[],
  slackToken: string,
  devrevToken: string
): Promise<string[]> => {
  const artifactIds: string[] = [];
  for (const attachment of attachments.slice(0, MAX_SLACK_ATTACHMENTS)) {
    try {
      artifactIds.push(await uploadSlackAttachment(devrev, attachment, slackToken, devrevToken));
    } catch (error) {
      console.warn('Failed to upload Slack attachment', {
        error: error instanceof Error ? error.message : 'unknown error',
        name: attachment.name,
      });
    }
  }
  return artifactIds;
};
