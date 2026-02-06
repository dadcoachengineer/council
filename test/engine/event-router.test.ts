import { describe, it, expect } from 'vitest';
import { EventRouter } from '@/engine/event-router.js';
import type { EventRoutingRule } from '@/shared/types.js';
import type { GithubWebhookEvent, GenericWebhookEvent } from '@/shared/events.js';

const rules: EventRoutingRule[] = [
  {
    match: { source: 'github', type: 'issues.opened', labels: ['bug'] },
    assign: { lead: 'cto', consult: ['cpo'] },
  },
  {
    match: { source: 'github', type: 'issues.opened', labels: ['feature-request'] },
    assign: { lead: 'cpo', consult: ['cto', 'finance'] },
  },
  {
    match: { source: 'github', type: 'pull_request.opened' },
    assign: { lead: 'cto', consult: [] },
  },
  {
    match: { source: 'generic' },
    assign: { lead: 'cto', consult: [] },
  },
];

describe('EventRouter', () => {
  const router = new EventRouter(rules);

  it('matches github bug issue', () => {
    const event: GithubWebhookEvent = {
      source: 'github',
      eventType: 'issues.opened',
      payload: {
        action: 'opened',
        repository: { full_name: 'org/repo' },
        issue: {
          number: 1,
          title: 'Bug report',
          body: 'Something is broken',
          labels: [{ name: 'bug' }],
          html_url: 'https://github.com/org/repo/issues/1',
        },
        sender: { login: 'user' },
      },
    };

    const result = router.route(event);
    expect(result).not.toBeNull();
    expect(result!.lead).toBe('cto');
    expect(result!.consult).toEqual(['cpo']);
  });

  it('matches feature request', () => {
    const event: GithubWebhookEvent = {
      source: 'github',
      eventType: 'issues.opened',
      payload: {
        action: 'opened',
        repository: { full_name: 'org/repo' },
        issue: {
          number: 2,
          title: 'Feature request',
          body: 'Would be nice to have...',
          labels: [{ name: 'feature-request' }],
          html_url: 'https://github.com/org/repo/issues/2',
        },
        sender: { login: 'user' },
      },
    };

    const result = router.route(event);
    expect(result!.lead).toBe('cpo');
    expect(result!.consult).toEqual(['cto', 'finance']);
  });

  it('matches PR opened', () => {
    const event: GithubWebhookEvent = {
      source: 'github',
      eventType: 'pull_request.opened',
      payload: {
        action: 'opened',
        repository: { full_name: 'org/repo' },
        pull_request: {
          number: 10,
          title: 'Add feature',
          body: 'Implements feature X',
          labels: [],
          html_url: 'https://github.com/org/repo/pull/10',
        },
        sender: { login: 'user' },
      },
    };

    const result = router.route(event);
    expect(result!.lead).toBe('cto');
    expect(result!.consult).toEqual([]);
  });

  it('matches generic webhook', () => {
    const event: GenericWebhookEvent = {
      source: 'generic',
      eventType: 'alert',
      payload: { message: 'Something happened' },
    };

    const result = router.route(event);
    expect(result!.lead).toBe('cto');
  });

  it('returns null for unmatched events', () => {
    const event: GithubWebhookEvent = {
      source: 'github',
      eventType: 'push',
      payload: {
        action: '',
        repository: { full_name: 'org/repo' },
        sender: { login: 'user' },
      },
    };

    const result = router.route(event);
    // push doesn't match issues.opened or pull_request.opened,
    // so it falls through. No generic github rule exists.
    expect(result).toBeNull();
  });

  it('requires all labels to match', () => {
    const event: GithubWebhookEvent = {
      source: 'github',
      eventType: 'issues.opened',
      payload: {
        action: 'opened',
        repository: { full_name: 'org/repo' },
        issue: {
          number: 3,
          title: 'Not a bug',
          body: 'This is labeled "enhancement" not "bug"',
          labels: [{ name: 'enhancement' }],
          html_url: 'https://github.com/org/repo/issues/3',
        },
        sender: { login: 'user' },
      },
    };

    const result = router.route(event);
    // Doesn't match bug or feature-request rules, falls through to PR rule which is issues.opened != pull_request.opened
    // Falls through to generic which is source: generic != github
    expect(result).toBeNull();
  });
});
