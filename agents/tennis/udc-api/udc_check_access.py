"""API для бронирования корта в UDC — безопасная проверка доступа к передаче."""
import getpass,json,sys,urllib.request,urllib.error
import udc_booker as u
key=getpass.getpass('UDC reporting key: ')
try:
 request=urllib.request.Request('https://hook.acrogym.org/tennis',data=b'{"date":"bad"}',headers={'Authorization':'Bearer '+key,'Accept':'application/json','Content-Type':'application/json'},method='POST')
 try:
  response=urllib.request.build_opener(u.NoRedirect()).open(request,timeout=25)
 except urllib.error.HTTPError as exc:
  response=exc
 with response:
  try:data=json.loads(response.read(8192))
  except ValueError:data={}
  error=str(data.get('err','')).replace(key,'[redacted]')[:300]
  print(json.dumps({'access_probe':True,'http_status':response.code,'ok':data.get('ok'),'err':error,'cloudflare_error':data.get('cloudflare_error'),'error_code':data.get('error_code')},ensure_ascii=False))
except (OSError,urllib.error.URLError):
 print(json.dumps({'access_probe':True,'outcome':'network_error'}))
finally:
 key=None
