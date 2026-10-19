const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/web/static/app.js','utf8');
const context={document:{createElement:tag=>({tag,className:'',textContent:''})}};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function el('),source.indexOf('// Presentation only:')),context);

test('dynamic controls retain their role classes and render labels as text',()=>{
  const action=context.el('button','<b>저장</b>','secondary action-icon');
  assert.match(action.className,/\bbtn\b/);
  assert.match(action.className,/\bsecondary action-icon\b/);
  assert.equal(action.textContent,'<b>저장</b>');
  assert.match(context.el('select').className,/\bform-select\b/);
  assert.match(context.el('textarea').className,/\bform-control\b/);
  assert.equal(context.el('input',undefined,'form-check-input').className,'form-check-input');
  assert.equal(context.el('div',undefined,'field-action-row').className,'field-action-row');
});
