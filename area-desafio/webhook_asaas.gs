/**
 * WEBHOOK ASAAS → FIRESTORE
 * Projeto: Desafio Destrave seu Emagrecimento
 *
 * CONFIGURAÇÃO (uma vez só):
 * 1. Google Cloud Console → IAM → Contas de serviço → Criar conta de serviço
 *    Nome: "desafio-webhook"  Papel: "Usuário do Cloud Datastore"
 * 2. Gerar chave JSON → copiar o conteúdo
 * 3. Apps Script → Configurações do projeto → Propriedades do script → Adicionar:
 *    CHAVE:  SERVICE_ACCOUNT_JSON
 *    VALOR:  (colar o conteúdo do JSON da chave)
 * 4. Implantar → Nova implantação → App da Web → "Qualquer pessoa" → Copiar URL
 * 5. Colar a URL no painel Asaas em Configurações → Webhooks
 */

var PROJECT_ID = 'desafio-bruna-boreggio';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var evento = body.event;

    // Processar apenas pagamentos confirmados
    if (evento !== 'PAYMENT_CONFIRMED' && evento !== 'PAYMENT_RECEIVED') {
      return ContentService.createTextOutput(JSON.stringify({ok:true,msg:'evento ignorado'}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var payment = body.payment;
    var email = '';

    // Tentar extrair email do pagamento
    if (payment) {
      email = (payment.customerEmail || payment.billingEmail || '').toLowerCase().trim();
      if (!email && payment.customer) {
        email = (payment.customer.email || '').toLowerCase().trim();
      }
    }

    if (!email) {
      logToSheet('ERRO', 'Email não encontrado no payload', JSON.stringify(body));
      return ContentService.createTextOutput(JSON.stringify({ok:false,msg:'email nao encontrado'}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Autorizar no Firestore
    autorizarEmail(email, payment);
    logToSheet('OK', email, evento);

    return ContentService.createTextOutput(JSON.stringify({ok:true,email:email}))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    logToSheet('EXCEÇÃO', err.message, e.postData ? e.postData.contents : '');
    return ContentService.createTextOutput(JSON.stringify({ok:false,error:err.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function autorizarEmail(email, payment) {
  var token = getFirebaseToken();
  var docPath = 'projects/' + PROJECT_ID + '/databases/(default)/documents/authorized/' + encodeURIComponent(email);
  var url = 'https://firestore.googleapis.com/v1/' + docPath;

  var data = {
    fields: {
      email:     { stringValue: email },
      liberado:  { booleanValue: true },
      ts:        { stringValue: new Date().toISOString() },
      plano:     { stringValue: (payment && payment.description) ? payment.description : 'desafio' },
      valor:     { stringValue: payment ? String(payment.value || '') : '' }
    }
  };

  var resp = UrlFetchApp.fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() >= 400) {
    throw new Error('Firestore PATCH falhou: ' + resp.getContentText());
  }
}

function getFirebaseToken() {
  var props = PropertiesService.getScriptProperties();
  var saJson = props.getProperty('SERVICE_ACCOUNT_JSON');
  if (!saJson) throw new Error('SERVICE_ACCOUNT_JSON não configurado nas propriedades do script');

  var sa = JSON.parse(saJson);
  var now = Math.floor(Date.now() / 1000);

  var header = Utilities.base64EncodeWebSafe(JSON.stringify({alg:'RS256',typ:'JWT'}));
  var claim  = Utilities.base64EncodeWebSafe(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore'
  }));

  var toSign = header + '.' + claim;
  var sig    = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(toSign, sa.private_key));
  var jwt    = toSign + '.' + sig;

  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }
  });

  return JSON.parse(resp.getContentText()).access_token;
}

/* Log em planilha para auditoria */
function logToSheet(status, email, detalhe) {
  try {
    var ss = SpreadsheetApp.openById(getPlanilhaId());
    var sheet = ss.getSheetByName('Webhook') || ss.insertSheet('Webhook');
    sheet.appendRow([new Date(), status, email, detalhe]);
  } catch(e) {
    // sem planilha configurada — ignora
  }
}

function getPlanilhaId() {
  return PropertiesService.getScriptProperties().getProperty('PLANILHA_ID') || '';
}

/* Teste manual: simula um pagamento */
function testeManual() {
  var payload = {
    event: 'PAYMENT_CONFIRMED',
    payment: {
      customerEmail: 'teste@exemplo.com',
      value: 97,
      description: 'Desafio Destrave seu Emagrecimento'
    }
  };
  doPost({ postData: { contents: JSON.stringify(payload) } });
  Logger.log('Teste concluído — verifique o Firestore');
}
