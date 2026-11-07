"""Finite contract gate; shared by the Python simulator and fixture tests."""
import hashlib
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / 'contracts/schema.json').read_text())
TRANSITIONS = json.loads((ROOT / 'contracts/transitions.json').read_text())


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(kind, value):
    schema = {**SCHEMA, '$ref': f'#/$defs/{kind}'}
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)
    if kind in ('Capture', 'ManifestEntry'):
        instant = datetime.fromisoformat(value['capturedAt'].replace('Z', '+00:00'))
        zone = ZoneInfo(value['timeZone'])
        require(int(instant.astimezone(zone).utcoffset().total_seconds()) == value['utcOffsetSeconds'], 'offset does not match zone at capture instant')
    if kind == 'Manifest':
        entries = value['captures']
        require(len(entries) == value['captureCount'], 'capture count')
        require(len({e['captureId'] for e in entries}) == len(entries), 'duplicate capture ID')
        require(len({e['uploadId'] for e in entries}) == len(entries), 'duplicate upload ID')
        start, end = value['sequenceStart'], value['sequenceEnd']
        require(0 <= end - start < 10000, 'bounded sequence range')
        require(value['startedAt'] <= value['cutoffAt'], 'cutoff before start')
        seen = set()
        for entry in entries:
            validate('ManifestEntry', entry)
            require(entry['deviceId'] == value['deviceId'] and entry['ownershipEpoch'] == value['ownershipEpoch'], 'capture identity mismatch')
            require(entry['sequence'] not in seen, 'duplicate sequence')
            require(start <= entry['sequence'] <= end, 'out of sequence range')
            require(entry['clockQuality'] == 'untrusted' or entry['capturedAt'] <= value['cutoffAt'], 'capture after cutoff')
            seen.add(entry['sequence'])
        for gap in value['gaps']:
            require(start <= gap['sequenceStart'] <= gap['sequenceEnd'] <= end, 'gap bounds')
            for seq in range(gap['sequenceStart'], gap['sequenceEnd'] + 1):
                require(seq not in seen, 'overlapping gap')
                seen.add(seq)
        require(len(seen) == end - start + 1, 'unexplained missing sequence')
    if kind == 'CalendarBundle':
        snapshot, pages, completion = value['snapshot'], value['pages'], value['completion']
        require(snapshot['windowStart'] < snapshot['windowEnd'], 'calendar window')
        require(len(pages) == snapshot['pageCount'], 'missing calendar page')
        require([p['pageNumber'] for p in pages] == list(range(len(pages))), 'page order')
        require(all(p['snapshotId'] == snapshot['snapshotId'] for p in pages), 'page identity')
        hashes = [digest(p) for p in pages]
        require(completion['pageHashes'] == hashes, 'page hash mismatch')
        require(completion['completionDigest'] == hashlib.sha256('\n'.join(hashes).encode()).hexdigest(), 'completion digest')
        ids = []
        for page in pages:
            for event in page['occurrences']:
                require(event['calendarId'] in snapshot['selectedCalendarIds'], 'unselected calendar')
                require(event['startAt'] < event['endAt'], 'event interval')
                require(event['startAt'] < snapshot['windowEnd'] and event['endAt'] > snapshot['windowStart'], 'event outside coverage')
                ids.append(event['occurrenceId'])
        require(len(set(ids)) == len(ids), 'duplicate occurrence')
    if kind == 'Transition':
        require(value['expectedRevision'] == value['revision'], 'stale transition')
        require(value['to'] in TRANSITIONS.get(value['machine'], {}).get(value['from'], []), 'illegal transition')


def main():
    from openapi_spec_validator import validate as validate_openapi
    Draft202012Validator.check_schema(SCHEMA)
    validate_openapi(json.loads((ROOT / 'contracts/openapi.json').read_text()))
    cases = json.loads((ROOT / 'fixtures/index.json').read_text())
    failures = []
    for case in cases:
        try:
            validate(case['schema'], json.loads((ROOT / case['file']).read_text()))
            accepted = True
        except Exception:
            accepted = False
        if accepted != case['valid']:
            failures.append(case['file'])
    transitions = json.loads((ROOT / 'fixtures/transitions.json').read_text())
    for case in transitions:
        try:
            validate('Transition', case['value'])
            accepted = True
        except Exception:
            accepted = False
        if accepted != case['valid']:
            failures.append(str(case['value']))
    # The same key must bind one canonical payload, including nested key ordering.
    require(digest({'b': 2, 'a': 1}) == digest({'a': 1, 'b': 2}), 'canonical key order')
    require(digest({'a': 1}) != digest({'a': 2}), 'changed payload conflict')
    require(not failures, 'fixture failures: ' + ', '.join(failures))
    print(f'Python: OpenAPI + schema valid; {len(cases)} fixtures; {len(transitions)} state/revision cases passed')


if __name__ == '__main__':
    main()
