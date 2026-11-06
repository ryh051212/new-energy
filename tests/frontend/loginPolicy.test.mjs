import test from 'node:test'
import assert from 'node:assert/strict'
import { loginValidation } from '../../src/features/auth/models/loginPolicy.js'
import { requestLocalSiting } from '../../src/features/planning/api/localSiting.js'
import { feedback, confirmAction, settleConfirmation, clearFeedback } from '../../src/shared/feedback/feedback.js'

test('login accepts 1–8 English letters and a password containing letters and digits',()=>{
  for(const name of ['a','Abcdefgh'])assert.equal(loginValidation(name,'Pass1234'),null)
  for(const name of ['','abcdefghi','admin1','张三','ab cd'])assert.equal(loginValidation(name,'Pass1234').field,'username')
  for(const password of ['abc123','abcdefgh','12345678','中文12345678'])assert.equal(loginValidation('admin',password).field,'password')
})

test('candidate confirmation posts selected ID to server and rejects stale choices',async()=>{
  const signal=new AbortController().signal
  let request
  const feature={type:'Feature',geometry:{type:'Point',coordinates:[113.83,34.03]},properties:{id:'local-a'}}
  const result=await requestLocalSiting({center:[113.83,34.03],candidateId:'local-a'},signal,true,async(path,options)=>{
    request={path,options};return {ok:true,json:async()=>feature}
  })
  assert.deepEqual(result,feature)
  assert.equal(request.path,'planning/local-candidates/confirm')
  assert.equal(request.options.signal,signal)
  assert.equal(JSON.parse(request.options.body).candidateId,'local-a')
  await assert.rejects(requestLocalSiting({},signal,true,async()=>({ok:false,status:422,json:async()=>({detail:'候选已不符合条件'})})),/候选已不符合条件/)
})

test('deletion only proceeds after acceptance and a replaced confirmation is canceled',async()=>{
  const first=confirmAction('删除 A',{clientX:12,clientY:14})
  assert.equal(feedback.confirmation.left,12)
  const second=confirmAction('删除 B')
  assert.equal(await first,false)
  settleConfirmation(true)
  assert.equal(await second,true)
  assert.equal(feedback.confirmation,null)
  const third=confirmAction('删除 C')
  clearFeedback()
  assert.equal(await third,false)
})
