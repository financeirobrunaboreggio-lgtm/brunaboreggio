/**
 * WEBHOOK ASAAS → PLANILHA + FIRESTORE
 * Projeto: Desafio Destrave seu Emagrecimento
 *
 * TODOS OS EVENTOS CAPTURADOS:
 *  PAYMENT_CREATED         → boleto/pix gerado (inicio do checkout)
 *  PAYMENT_CONFIRMED       → pagamento confirmado (cartão/pix) → libera Firestore
 *  PAYMENT_RECEIVED        → pagamento compensado (boleto)     → libera Firestore
 *  PAYMENT_OVERDUE         → boleto vencido sem pagamento
 *  PAYMENT_DELETED         → pagamento cancelado
 *  PAYMENT_CHECKOUT_VIEWED → carrinho visualizado (abandono)
 *  PAYMENT_REFUNDED        → reembolso realizado
 *  (outros eventos ficam registrados na aba Eventos)
 *
 * CONFIGURAÇÃO (uma vez só):
 * 1. Google Cloud Console → IAM → Contas de serviço → Criar conta de serviço
 *    Nome: "desafio-webhook"  Papel: "Usuário do Cloud Datastore"
 * 2. Gerar chave JSON → copiar o conteúdo
 * 3. Apps Script → Configurações → Propriedades do script → Adicionar:
 *    CHAVE: SERVICE_ACCOUNT_JSON  VALOR: (colar o JSON da chave)
 *    CHAVE: PLANILHA_ID           VALOR: (ID da planilha Google Sheets)
 * 4. Implantar → Nova implantação → App da Web → "Qualquer pessoa" → Copiar URL
 * 5. Colar a URL no painel Asaas em Configurações → Webhooks
 */

var PROJECT_ID = 'desafio-bruna-boreggio';

function doPost(e) {
  try {
    var body    = JSON.parse(e.postData.contents);
    var evento  = body.event || 'DESCONHECIDO';
    var payment = body.payment || {};

    /* Extrai dados do pagamento */
    var email  = (payment.customerEmail
                  || payment.billingEmail
                  || (payment.customer && payment.customer.email)
                  || '').toLowerCase().trim();
    var nome   = payment.customerName
                 || (payment.customer && payment.customer.name)
                 || '';
    var fone   = payment.customerMobilePhone
                 || (payment.customer && payment.customer.mobilePhone)
                 || '';
    var valor  = payment.value  != null ? String(payment.value)  : '';
    var descr  = payment.description || '';
    var status = payment.status       || '';

    /* Registra TODOS os eventos na aba Eventos */
    logEventos(evento, nome, email, fone, valor, descr, status);

    /* Apenas pagamentos confirmados liberam acesso no Firestore */
    if (evento === 'PAYMENT_CONFIRMED' || evento === 'PAYMENT_RECEIVED') {
      if (!email) {
        logToSheet('ERRO', 'Email nao encontrado', JSON.stringify(body));
        return ContentService.createTextOutput(
          JSON.stringify({ok:false, msg:'email nao encontrado'}))
          .setMimeType(ContentService.MimeType.JSON);
      }
      autorizarEmail(email, payment);
      logToSheet('LIBERADO', email, evento);
    }

    return ContentService.createTextOutput(
      JSON.stringify({ok:true, evento:evento, email:email||'n/a'}))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    logToSheet('EXCECAO', err.message, e.postData ? e.postData.contents : '');
    return ContentService.createTextOutput(
      JSON.stringify({ok:false, error:err.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/* ─── ABA EVENTOS — registra absolutamente tudo ─── */
function logEventos(evento, nome, email, fone, valor, descr, status) {
  try {
    var ss = SpreadsheetApp.openById(getPlanilhaId());
    var sh = ss.getSheetByName('Eventos');
    if (!sh) {
      sh = ss.insertSheet('Eventos');
      sh.appendRow(['Data/Hora','Evento','Nome','Email','Telefone','Valor (R$)','Descricao','Status Asaas']);
      sh.setFrozenRows(1);
      sh.getRange(1,1,1,8).setFontWeight('bold');
    }
    sh.appendRow([new Date(), evento, nome, email, fone, valor, descr, status]);
  } catch(e) { /* planilha nao configurada — ignora */ }
}

/* ─── FIRESTORE — libera acesso ao aluno ─── */
function autorizarEmail(email, payment) {
  var token   = getFirebaseToken();
  var docPath = 'projects/' + PROJECT_ID + '/databases/(default)/documents/authorized/' + encodeURIComponent(email);
  var url     = 'https://firestore.googleapis.com/v1/' + docPath;

  var data = {
    fields: {
      email:    { stringValue: email },
      liberado: { booleanValue: true },
      ts:       { stringValue: new Date().toISOString() },
      plano:    { stringValue: (payment && payment.description) ? payment.description : 'desafio' },
      valor:    { stringValue: payment ? String(payment.value || '') : '' }
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

/* ─── JWT para autenticação no Firestore ─── */
function getFirebaseToken() {
  var props = PropertiesService.getScriptProperties();
  var saJson = props.getProperty('SERVICE_ACCOUNT_JSON');
  if (!saJson) throw new Error('SERVICE_ACCOUNT_JSON nao configurado nas propriedades do script');

  var sa  = JSON.parse(saJson);
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
  var sig    = Utilities.base64EncodeWebSafe(
                 Utilities.computeRsaSha256Signature(toSign, sa.private_key));
  var jwt    = toSign + '.' + sig;

  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }
  });

  return JSON.parse(resp.getContentText()).access_token;
}

/* ─── Log de auditoria (aba Webhook) ─── */
function logToSheet(status, email, detalhe) {
  try {
    var ss    = SpreadsheetApp.openById(getPlanilhaId());
    var sheet = ss.getSheetByName('Webhook') || ss.insertSheet('Webhook');
    sheet.appendRow([new Date(), status, email, detalhe]);
  } catch(e) { /* sem planilha configurada — ignora */ }
}

function getPlanilhaId() {
  return PropertiesService.getScriptProperties().getProperty('PLANILHA_ID') || '';
}

/* ─── Teste manual ─── */
function testeManual() {
  var payload = {
    event: 'PAYMENT_CONFIRMED',
    payment: {
      customerEmail: 'teste@exemplo.com',
      customerName: 'Pessoa Teste',
      value: 97,
      status: 'CONFIRMED',
      description: 'Desafio Destrave seu Emagrecimento'
    }
  };
  doPost({ postData: { contents: JSON.stringify(payload) } });
  Logger.log('Teste concluido — verifique as abas Eventos e Webhook na planilha');
}

function testeCarrinhoAbandonado() {
  var payload = {
    event: 'PAYMENT_CHECKOUT_VIEWED',
    payment: {
      customerEmail: 'curioso@exemplo.com',
      customerName: 'Curioso Silva',
      value: 97,
      status: 'PENDING',
      description: 'Desafio Destrave seu Emagrecimento'
    }
  };
  doPost({ postData: { contents: JSON.stringify(payload) } });
  Logger.log('Teste carrinho abandonado — verifique a aba Eventos');
}

function testeBoletoVencido() {
  var payload = {
    event: 'PAYMENT_OVERDUE',
    payment: {
      customerEmail: 'atrasado@exemplo.com',
      customerName: 'Maria Teste',
      value: 97,
      status: 'OVERDUE',
      description: 'Desafio Destrave seu Emagrecimento'
    }
  };
  doPost({ postData: { contents: JSON.stringify(payload) } });
  Logger.log('Teste boleto vencido — verifique a aba Eventos');
}
