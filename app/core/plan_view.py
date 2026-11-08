"""Rebuild a chat's Claude task list from its recorded plan events."""
import json


def build_plan(runs, events):
    latest = runs[-1] if runs else None
    response = {'agent': latest['adapter'] if latest else None,
                'run': {'id': latest['id'], 'status': latest['status']} if latest else None,
                'items': [], 'earlierCompleted': [], 'endedWithOpenItems': False}
    if response['agent'] != 'claude':
        return response
    plans = []
    for row in events:
        try:
            event = json.loads(row['text'])
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and isinstance(event.get('session'), str) and event['session']:
            plans.append((row['run_id'], event))
    if not plans:
        return response
    session = plans[-1][1]['session']
    items, changed = {}, {}
    for run_id, event in plans:
        if event['session'] != session:
            continue
        op, identity = event.get('op'), event.get('id')
        if op == 'create':
            updates = [{'activeForm': None, **event}]
        elif op == 'update':
            if identity not in items:
                continue
            if event.get('status') == 'deleted':
                del items[identity]
                continue
            updates = [event]
        elif op == 'snapshot':
            updates = event['tasks']
            identities = {task['id'] for task in updates}
            items = {key: item for key, item in items.items() if key in identities}
        else:
            continue
        for task in updates:
            identity = task['id']
            fields = {key: task[key] for key in ('id', 'subject', 'activeForm', 'status') if key in task}
            item = {'activeForm': None, **items.get(identity, {}), **fields}
            if item != items.get(identity):
                changed[identity] = run_id
            items[identity] = item
    for identity in sorted(items, key=int):
        item = items[identity]
        this_run = changed[identity] == latest['id']
        if item['status'] in ('pending', 'in_progress') or this_run:
            response['items'].append({**item, 'thisRun': this_run})
        elif item['status'] == 'completed':
            response['earlierCompleted'].append({'id': identity, 'subject': item['subject']})
    response['endedWithOpenItems'] = latest['status'] in ('completed', 'failed', 'interrupted') and any(
        item['status'] in ('pending', 'in_progress') for item in response['items'])
    return response
