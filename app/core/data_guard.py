"""Local-only attachment guard. Detectors never validate credentials over a network."""
from dataclasses import dataclass
import re

from detect_secrets.plugins.aws import AWSKeyDetector
from detect_secrets.plugins.azure_storage_key import AzureStorageKeyDetector
from detect_secrets.plugins.basic_auth import BasicAuthDetector
from detect_secrets.plugins.github_token import GitHubTokenDetector
from detect_secrets.plugins.gitlab_token import GitLabTokenDetector
from detect_secrets.plugins.jwt import JwtTokenDetector
from detect_secrets.plugins.keyword import KeywordDetector
from detect_secrets.plugins.openai import OpenAIDetector
from detect_secrets.plugins.private_key import PrivateKeyDetector
from detect_secrets.plugins.slack import SlackDetector
from detect_secrets.plugins.stripe import StripeDetector
from detect_secrets.plugins.high_entropy_strings import Base64HighEntropyString, HexHighEntropyString
from pydantic import Field
from typing import Literal
from app.models.schemas import StrictModel

RULE_VERSION = 'kr-attachments-1-detect-secrets-1.5.0'
Level = Literal['strong', 'medium', 'low', 'allow']
Kind = Literal['name', 'phone', 'email', 'identity', 'user_id', 'secret']


class FieldRule(StrictModel):
    field: str = Field(min_length=1, max_length=60)
    kind: Kind


class GuardOptions(StrictModel):
    level: Level = 'strong'
    fields: list[FieldRule] = Field(default_factory=list, max_length=30)


@dataclass
class Part:
    location: str
    text: str
    field: str = ''


PHONE = re.compile(r'(?<!\d)(?:\+82[ -]?(?:10|1[16789]|2|[3-6]\d)|0(?:10|1[16789]|2|[3-6]\d))[ -]?\d{3,4}[ -]?\d{4}(?!\d)')
IDENTITY = re.compile(r'(?<!\d)\d{6}[ -]?[1-8]\d{6}(?!\d)')
EMAIL = re.compile(r'(?i)(?<![\w.+-])[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}(?![\w.-])')
ASSIGNMENT = re.compile(r'''(?im)["']?(?:[\w.-]*[_-])?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key)["']?\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;]+))''')
DB_URI = re.compile(r'(?i)\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|mssql)://([^\s/@]+)@')
PRIVATE = re.compile(r'(?i)(?:BEGIN [A-Z0-9 ]*PRIVATE KEY|PuTTY-User-Key-File-[23])')
FIELDS = {
    'name': {'이름', '성명', '고객명', 'name', 'full_name'},
    'phone': {'전화번호', '연락처', '휴대전화', '휴대폰', 'phone', 'mobile'},
    'email': {'이메일', 'email', 'e-mail'},
    'identity': {'주민등록번호', '주민번호', '외국인등록번호', '여권번호', '운전면허번호', '계좌번호'},
    'user_id': {'사용자아이디', '사용자id', '아이디', 'userid', 'user_id', 'username', 'db_username', '사번', '고객번호'},
    'secret': {'비밀번호', '암호', 'password', 'passwd', 'pwd', 'db_password', 'api_key', 'apikey', 'secret', 'token', 'access_token', 'aws_secret_access_key'},
}


def field_kind(field, options):
    normalized = field.strip().lower().replace(' ', '')
    for rule in reversed(options.fields):
        if rule.field.strip().lower().replace(' ', '') == normalized:
            return rule.kind
    return next((kind for kind, fields in FIELDS.items() if normalized in fields), None)


def replacement(value, kind, level):
    if level == 'allow' or (level == 'low' and kind not in ('secret', 'identity')):
        return value, 'raw'
    if level == 'medium' and kind not in ('secret', 'identity'):
        if kind == 'name':
            masked = value[0] + ('*' * (len(value)-2) + value[-1] if len(value)>2 else '*')
        elif kind == 'phone':
            digits = re.sub(r'\D', '', value)
            masked = digits[:3]+'-****-'+digits[-4:] if len(digits)>=10 else '[전화번호]'
        elif kind == 'email' and '@' in value:
            local, domain = value.rsplit('@', 1)
            masked = local[:1]+'***@'+domain
        else:
            keep = min(4, max(0, len(value)-3))
            masked = value[:keep]+'*'*max(3, len(value)-keep)
        return masked, 'masked'
    return '['+{'name':'이름','phone':'전화번호','email':'이메일','identity':'고위험 식별정보','user_id':'사용자 ID','secret':'비밀값'}[kind]+']', 'redacted'


def guard(parts, options):
    # Direct analyze_string calls only: no scan filters, verify methods, plugins from user paths,
    # global transient settings, remote validation, or model calls.
    detectors = [cls() for cls in (AWSKeyDetector, AzureStorageKeyDetector, BasicAuthDetector,
        GitHubTokenDetector, GitLabTokenDetector, JwtTokenDetector, KeywordDetector,
        OpenAIDetector, PrivateKeyDetector, SlackDetector, StripeDetector)]
    entropy = [Base64HighEntropyString(), HexHighEntropyString()]
    findings, output = [], []
    blocked = False
    for part in parts:
        text = part.text
        if PRIVATE.search(text):
            findings.append({'location':part.location, 'kind':'private_key', 'action':'raw' if options.level=='allow' else 'blocked', 'count':1})
            if options.level != 'allow':
                blocked = True
                continue
        spans = []
        kind = field_kind(part.field, options)
        if kind and text.strip():
            start = len(text)-len(text.lstrip()); end = len(text.rstrip())
            spans.append((start, end, kind))
        for match in re.finditer(r'(?m)^\s*([\w가-힣 -]{1,60})\s*[:=]\s*(.+)$', text):
            labeled = field_kind(match.group(1), options)
            if labeled: spans.append((*match.span(2), labeled))
        for match in ASSIGNMENT.finditer(text):
            group = next(i for i in (1,2,3) if match.group(i) is not None)
            spans.append((*match.span(group), 'secret'))
        for match in DB_URI.finditer(text):
            spans.append((*match.span(1), 'secret'))
        for detector in detectors:
            for value in set(detector.analyze_string(text)):
                if not value: continue
                for match in re.finditer(re.escape(value), text):
                    spans.append((*match.span(), 'secret'))
        for detector in entropy:
            for value in set(detector.analyze_string(text)):
                if len(value)>=20 and detector.calculate_shannon_entropy(value)>detector.entropy_limit:
                    for match in re.finditer(re.escape(value), text):
                        spans.append((*match.span(), 'secret'))
        for kind, pattern in [('identity', IDENTITY), ('phone', PHONE), ('email', EMAIL)]:
            spans.extend((*match.span(), kind) for match in pattern.finditer(text))
        # Union overlaps, giving secrets precedence so a field mask cannot weaken a key guard.
        merged = []
        rank = {'secret':0,'identity':1,'phone':2,'email':3,'name':4,'user_id':5}
        for start, end, kind in sorted(set(spans)):
            if merged and start < merged[-1][1]:
                old = merged[-1]; merged[-1] = (old[0], max(end,old[1]), min((old[2],kind), key=rank.get))
            else: merged.append((start,end,kind))
        for start,end,kind in reversed(merged):
            value, action = replacement(text[start:end],kind,options.level)
            text = text[:start]+value+text[end:]
            findings.append({'location':part.location,'kind':kind,'action':action,'count':1})
            if len(findings)>10000: raise ValueError('탐지 결과 한도를 초과했습니다.')
        output.append({'location':part.location, 'text':text})
    # No finding contains the matched value, field label or raw filename.
    return {'status':'blocked' if blocked else 'ready', 'level':options.level,
        'rule_version':RULE_VERSION,'findings':findings,
        'parts':[] if blocked else output}
