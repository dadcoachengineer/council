import type { EventRoutingRule } from '../shared/types.js';
import type { WebhookEvent, GithubWebhookEvent } from '../shared/events.js';

export interface RouteResult {
  lead: string;
  consult: string[];
  matchedRule: EventRoutingRule;
}

/**
 * Match an incoming webhook event against routing rules
 * and determine which agents should handle it.
 */
export class EventRouter {
  constructor(private rules: EventRoutingRule[]) {}

  /**
   * Find the first matching routing rule for an event.
   * Returns null if no rule matches.
   */
  route(event: WebhookEvent): RouteResult | null {
    for (const rule of this.rules) {
      if (this.matches(rule, event)) {
        return {
          lead: rule.assign.lead,
          consult: rule.assign.consult,
          matchedRule: rule,
        };
      }
    }
    return null;
  }

  private matches(rule: EventRoutingRule, event: WebhookEvent): boolean {
    // Match source
    if (rule.match.source !== event.source) {
      return false;
    }

    // Match event type (if specified)
    if (rule.match.type && rule.match.type !== event.eventType) {
      return false;
    }

    // Match labels (if specified, for GitHub events)
    if (rule.match.labels && rule.match.labels.length > 0) {
      if (event.source === 'github') {
        const ghEvent = event as GithubWebhookEvent;
        const eventLabels = this.extractLabels(ghEvent);
        const hasAllLabels = rule.match.labels.every((label) =>
          eventLabels.includes(label),
        );
        if (!hasAllLabels) {
          return false;
        }
      }
    }

    return true;
  }

  private extractLabels(event: GithubWebhookEvent): string[] {
    const issue = event.payload.issue;
    if (issue) {
      return issue.labels.map((l) => l.name);
    }
    const pr = event.payload.pull_request;
    if (pr) {
      return pr.labels.map((l) => l.name);
    }
    return [];
  }

  updateRules(rules: EventRoutingRule[]): void {
    this.rules = rules;
  }
}
