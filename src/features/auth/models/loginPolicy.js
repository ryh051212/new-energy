export const USERNAME_HINT='用户名只能包含英文字母，最多 8 个字母'
export const PASSWORD_HINT='密码至少 8 位，必须同时包含英文字母和数字'

export function loginValidation(username,password){
  if(!/^[A-Za-z]{1,8}$/.test(username))return {field:'username',message:USERNAME_HINT}
  if(password.length<8 || password.length>256 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
    return {field:'password',message:PASSWORD_HINT}
  return null
}
