#!/usr/bin/env python3
"""Regenerate the finite provider-block projection in waf.tf (development only).

Terraform has no recursive block function. The caller supplies native-shaped
objects; this generator unrolls their supported three-level schema. Validation
lives separately in waf-validation.tf. No generator is run by module consumers.
"""
from pathlib import Path

lines = []
def emit(text='', indent=0):
    lines.append('  ' * indent + text)
def dynamic(name, value, iterator, indent, body):
    emit(f'dynamic "{name}" {{', indent)
    parent, key = value.rsplit('.', 1)
    emit(f'for_each = contains(keys({parent}), "{key}") ? ({value} == null ? [] : [{value}]) : []', indent+1)
    emit(f'iterator = {iterator}', indent+1)
    emit('content {', indent+1)
    body(f'{iterator}.value', indent+2)
    emit('}', indent+1)
    emit('}', indent)
def repeated(name, value, iterator, indent, body):
    emit(f'dynamic "{name}" {{', indent)
    parent, key = value.rsplit('.', 1)
    emit(f'for_each = {{ for index, item in lookup({parent}, "{key}", null)[*] : tostring(index) => item }}', indent+1)
    emit(f'iterator = {iterator}', indent+1)
    emit('content {', indent+1)
    body(f'{iterator}.value', indent+2)
    emit('}', indent+1)
    emit('}', indent)
def attr(key, value, indent, default=None):
    val=f'try({value}.{key}, null)' if default is None else f'coalesce(try({value}.{key}, null), {default})'
    emit(f'{key} = {val}', indent)
def response(value, indent):
    attr('response_code',value,indent)
    emit(f'custom_response_body_key = try({value}.custom_response_body_key, null)',indent)
    def header(v,i):
        attr('name',v,i);attr('value',v,i)
    repeated('response_header',f'{value}.response_header','header',indent,header)
def actions(value,indent,kinds):
    for kind in kinds:
        def body(v,i,k=kind):
            if k=='block':dynamic('custom_response',f'{v}.custom_response','response',i,response)
        dynamic(kind,f'{value}.{kind}',f'act_{kind}',indent,body)
def visibility(value,indent,metric):
    emit('visibility_config {',indent)
    attr('cloudwatch_metrics_enabled',value,indent+1,'true')
    attr('sampled_requests_enabled',value,indent+1,'false')
    attr('metric_name',value,indent+1,metric)
    emit('}',indent)
def field(value,indent):
    for name in ['method','uri_path','query_string','all_query_arguments','single_header','single_query_argument']:
        def body(v,i,n=name):
            if n in ['single_header','single_query_argument']:attr('name',v,i)
        dynamic(name,f'{value}.{name}',f'field_{name}',indent,body)
def transformed(value,indent):
    dynamic('field_to_match',f'{value}.field_to_match','field',indent,field)
    def transform(v,i):attr('priority',v,i);attr('type',v,i)
    repeated('text_transformation',f'{value}.text_transformation','transform',indent,transform)
def overrides(value,indent):
    def override(v,i):
        attr('name',v,i)
        emit('action_to_use {',i)
        actions(f'{v}.action_to_use',i+1,['allow','block','count'])
        emit('}',i)
    repeated('rule_action_override',f'{value}.rule_action_override','override',indent,override)
def statement(value,indent,level):
    leafs={
        'geo_match_statement':['country_codes'],
        'ip_set_reference_statement':['arn'],
        'label_match_statement':['key','scope'],
        'byte_match_statement':['search_string','positional_constraint'],
        'regex_match_statement':['regex_string'],
        'regex_pattern_set_reference_statement':['arn'],
        'size_constraint_statement':['size','comparison_operator'],
        'sqli_match_statement':[],
        'xss_match_statement':[],
    }
    for kind,attrs in leafs.items():
        def body(v,i,k=kind,keys=attrs):
            for key in keys:attr(key,v,i)
            if k=='sqli_match_statement':emit(f'sensitivity_level = try({v}.sensitivity_level, null)',i)
            if k in ['byte_match_statement','regex_match_statement','regex_pattern_set_reference_statement','size_constraint_statement','sqli_match_statement','xss_match_statement']:transformed(v,i)
        dynamic(kind,f'{value}.{kind}',f'leaf{level}',indent,body)
    if level<3:
        for kind in ['and_statement','or_statement','not_statement']:
            def body(v,i,k=kind):
                if k=='not_statement':
                    emit('statement {',i)
                    statement(f'{v}.statement',i+1,level+1)
                    emit('}',i)
                else:
                    repeated('statement',f'{v}.statement',f'child{level+1}',i,lambda child,j:statement(child,j,level+1))
            dynamic(kind,f'{value}.{kind}',f'logical{level}',indent,body)
    if level==1:
        def rate(v,i):
            attr('aggregate_key_type',v,i);attr('limit',v,i);attr('evaluation_window_sec',v,i,'300')
            dynamic('scope_down_statement',f'{v}.scope_down_statement','scope2',i,lambda child,j:statement(child,j,2))
        dynamic('rate_based_statement',f'{value}.rate_based_statement','rate',indent,rate)
        def managed(v,i):
            attr('name',v,i);attr('vendor_name',v,i)
            emit(f'version = try({v}.version, null)',i)
            overrides(v,i)
            dynamic('scope_down_statement',f'{v}.scope_down_statement','scope2',i,lambda child,j:statement(child,j,2))
        dynamic('managed_rule_group_statement',f'{value}.managed_rule_group_statement','managed',indent,managed)
        def group(v,i):attr('arn',v,i);overrides(v,i)
        dynamic('rule_group_reference_statement',f'{value}.rule_group_reference_statement','group',indent,group)

emit('# Generated by scripts/generate-waf.py; edit that projection, not repeated blocks.')
emit('# The whole ACL is owned inline; no rule_json or ignored rule drift.')
emit('resource "aws_wafv2_ip_set" "allowlist" {')
emit('for_each = local.waf_enabled ? toset(["IPV4", "IPV6"]) : toset([])',1)
emit('depends_on = [terraform_data.target_account_guard, terraform_data.waf_guard]',1)
emit('region = "us-east-1"',1)
emit('name = "${var.name_prefix}-allowlist-${lower(each.key)}"',1)
emit('scope = "CLOUDFRONT"',1)
emit('ip_address_version = each.key',1)
emit('addresses = local.waf_has_allowlist ? local.waf_family_cidrs[each.key] : []',1)
emit('tags = var.tags',1)
emit('}')
emit()
emit('resource "aws_wafv2_web_acl" "viewer" {')
emit('count = local.waf_enabled ? 1 : 0',1)
emit('depends_on = [terraform_data.target_account_guard, terraform_data.waf_guard, aws_wafv2_ip_set.allowlist]',1)
emit('region = "us-east-1"',1)
emit('name = "${var.name_prefix}-viewer"',1)
emit('scope = "CLOUDFRONT"',1)
emit('tags = var.tags',1)
emit('lifecycle {',1);emit('prevent_destroy = true',2);emit('}',1)
emit('default_action {',1)
actions('var.waf_custom_rules.default_action',2,['allow','block'])
emit('}',1)
visibility('var.waf_custom_rules.visibility_config',1,'"${var.name_prefix}-viewer"')
def custom_body(v,i):
    emit('key = body.key',i);attr('content',v,i);attr('content_type',v,i)
emit('dynamic "custom_response_body" {',1)
emit('for_each = var.waf_custom_rules.custom_response_bodies',2)
emit('iterator = body',2);emit('content {',2);custom_body('body.value',3);emit('}',2);emit('}',1)
emit('dynamic "rule" {',1)
emit('for_each = local.waf_has_allowlist ? [1] : []',2)
emit('iterator = preset',2)
emit('content {',2)
emit('name = "artifact-pages-ip-allowlist"',3);emit('priority = 0',3)
emit('action {',3);emit('block {',4);emit('custom_response {',5);emit('response_code = 403',6);emit('}',5);emit('}',4);emit('}',3)
emit('statement {',3);emit('not_statement {',4);emit('statement {',5);emit('or_statement {',6)
for family in ['IPV4','IPV6']:
    emit('statement {',7);emit('ip_set_reference_statement {',8);emit(f'arn = aws_wafv2_ip_set.allowlist["{family}"].arn',9);emit('}',8);emit('}',7)
emit('}',6);emit('}',5);emit('}',4);emit('}',3)
visibility('merge(var.waf_custom_rules.visibility_config, {metric_name = null})',3,'"${var.name_prefix}-ip-allowlist"')
emit('}',2);emit('}',1)
emit('dynamic "rule" {',1)
emit('for_each = local.waf_rule_values',2)
emit('iterator = free_rule',2);emit('content {',2)
v='free_rule.value'
attr('name',v,3);attr('priority',v,3)
dynamic('action',f'{v}.action','ordinary',3,lambda a,i:actions(a,i,['allow','block','count']))
dynamic('override_action',f'{v}.override_action','group_action',3,lambda a,i:actions(a,i,['none','count']))
emit('statement {',3);statement(f'{v}.statement',4,1);emit('}',3)
visibility(f'{v}.visibility_config',3,f'"${{var.name_prefix}}-r-${{substr(sha256({v}.name), 0, 20)}}"')
emit('}',2);emit('}',1);emit('}')
Path(__file__).resolve().parent.parent.joinpath('waf.tf').write_text('\n'.join(lines)+'\n')
