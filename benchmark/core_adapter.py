"""Real public-CLI adapter. Exit 3 UNKNOWN is delivered, never rewritten as exit 0."""
import hashlib
import json
from pathlib import Path
import subprocess

FROZEN_PRODUCT = '1c3d5a795c1ebb8491cec4e2e48abe15a5d05c01'
SCHEMA_DIGEST = 'ee6dea1ca29c8f8151a257bac6fe9f1091275f0f0b31d4b39fb02836eb1b372e'


def verify_product(product, commit):
    """Refuse dirty/moving product code; inspect only, never install or mutate it."""
    product = Path(product).resolve()
    def git(*args):
        return subprocess.check_output(['git', '-C', str(product), *args], text=True).strip()
    if git('rev-parse', 'HEAD') != commit or git('status', '--porcelain', '--untracked-files=all'):
        raise ValueError('product must be clean at explicitly pinned commit')
    schema = product / 'docs/sourcemark-registry-v1.md'
    if hashlib.sha256(schema.read_bytes()).hexdigest() != SCHEMA_DIGEST:
        raise ValueError('registry schema changed; review contract before running')
    return product


def delivered(record, subject, scope):
    if record.get('failure') not in (None, 'nonzero_exit'):
        return False
    try:
        value = json.loads(record['stdout'])
    except (ValueError, TypeError, KeyError):
        return False
    return (isinstance(value, dict) and value.get('subject') == subject
            and value.get('scope') == scope
            and (record.get('returncode'), value.get('status')) in
                ((0, 'attributed'), (3, 'unknown')))


def context(directory, product, commit, timeout, invoke, node='node'):
    product = verify_product(product, commit)
    directory = Path(directory).resolve()
    selector = json.loads((directory / '.sourcemark/selector.json').read_text())
    if selector.get('schema_version') != 1 or any(
            not isinstance(selector.get(key), str) or not selector[key]
            for key in ('subject', 'scope', 'reader_model')):
        raise ValueError('invalid exact case selector')
    argv = [node, str(product / 'bin/sourcemark.js'), 'context', '--project', str(directory),
            '--subject', selector['subject'], '--scope', selector['scope'],
            '--model', selector['reader_model'], '--json']
    record = invoke(argv, directory, timeout)
    record.update(product_commit=commit, registry_schema_sha256=SCHEMA_DIGEST,
                  selector=selector, delivered=delivered(record, selector['subject'], selector['scope']))
    # Preserve stdout/stderr/raw exit/failure verbatim, including nonzero_exit for UNKNOWN.
    return record
