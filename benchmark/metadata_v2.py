"""Protocol 2 synthetic observations: source quotations, never grading answers."""
import hashlib
import json
import re

VARIANT = 'explicit-source-observations-v2'
REGISTRY_PATHS = ('.sourcemark/sources.json', '.sourcemark/claims.json',
                  '.sourcemark/context-map.json', '.sourcemark/selector.json',
                  '.sourcemark/FIXTURE.md')
NOTICE = ('FICTIONAL FIXTURE RECORDS: authors, model/session identifiers and dates are '
          'synthetic narrative metadata, not real people, executions or verification. '
          'Values quote source lines; completeness describes that quotation only, '
          'not the completeness or truth of the underlying instrument. No network observations.\n')


def registries(source_files, subject):
    """Consume visible source bytes only. No CASES or decision keys are accepted."""
    sources, claims, paths = [], [], []
    for number, (name, text) in enumerate(source_files.items()):
        if name.startswith('.keel/'):
            continue
        ident = 'source-' + str(number)
        # Snapshot/config/code/ledger are canonical local documents, NOT fresh live probes.
        tier = 'canonical' if name.startswith(('config/', 'src/', 'ledger/', 'observations/', 'canonical/')) or name == 'config.json' else 'memory'
        sources.append(dict(id=ident, tier=tier, path=name))
        paths.append(dict(path=name, subject=subject, scope='source-observations'))
        for line_number, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            # Only explicit claim dates count. File-edit/checkout dates do not reverify.
            match = re.search(r'(?:[Vv]erified[ :\"]+|[Oo]bserved[ :\"]+)(\d{4}-\d\d-\d\d)', line)
            if not match and name.startswith('ledger/'):
                match = re.match(r'(\d{4}-\d\d-\d\d)', line)
            at = match.group(1) + 'T00:00:00Z' if match else None
            locator = f'{name}:{line_number}'
            claims.append(dict(id=f'{ident}-line-{line_number}', subject=subject,
                scope='source-observations', value=line, source=ident, locator=locator,
                source_digest=hashlib.sha256(text.encode()).hexdigest(),
                observed_at=at, verified_at=at,
                writer=dict(agent='FICTIONAL-source-observer', model='FICTIONAL-no-model',
                            session=f'FICTIONAL-{ident}'),
                evidence=dict(reference=locator, complete=True, fixture_notice=NOTICE.strip()),
                supersedes=[]))
    values = [dict(schema_version=1, sources=sources), dict(schema_version=1, claims=claims),
              dict(schema_version=1, paths=paths),
              dict(schema_version=1, subject=subject, scope='source-observations',
                   reader_model='FICTIONAL-different-reader')]
    result = {path: json.dumps(value, indent=2, sort_keys=True) + '\n'
              for path, value in zip(REGISTRY_PATHS, values)}
    result[REGISTRY_PATHS[-1]] = NOTICE
    return result
