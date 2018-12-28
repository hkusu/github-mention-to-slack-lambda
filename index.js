var https = require('https');
const API_TOKEN = process.env['API_TOKEN'];
const settings = require('./settings.json');

exports.handler = async (event) => {
  const gitHubBody = JSON.parse(event.body);

  const gitHub = {
    event: event.headers['X-GitHub-Event'],
    action: gitHubBody.action,
    repository: gitHubBody.repository.full_name,
    pullRequest: gitHubBody.pull_request,
    issue: gitHubBody.issue,
    comment: gitHubBody.comment,
    senderName: gitHubBody.sender.login,
    senderUrl: gitHubBody.sender.html_url,
    senderIconUrl: gitHubBody.sender.avatar_url,
  };

  const message = {
    title: null,
    url: null,
    body: null,
  }

  // Pull request の description
  if (gitHub.event === 'pull_request' && (gitHub.action === 'opened' || gitHub.action === 'edited')) {
    message.title = `#${gitHub.pullRequest.number} ${gitHub.pullRequest.title}`;
    message.url = gitHub.pullRequest.html_url;
    message.body = gitHub.pullRequest.body;
  }
  // Issue の description
  else if (gitHub.event === 'issues' && (gitHub.action === 'opened' || gitHub.action === 'edited'))  {
    message.title = `#${gitHub.issue.number} ${gitHub.issue.title}`;
    message.url = gitHub.issue.html_url;
    message.body = gitHub.issue.body;
  }
  // Pull request または Issue のコメント
  else if (gitHub.event === 'issue_comment' && (gitHub.action === 'created' || gitHub.action === 'edited'))  {
    message.title = `Comment on #${gitHub.issue.number} ${gitHub.issue.title}`;
    message.url = gitHub.comment.html_url;
    message.body = gitHub.comment.body;
  }
  // Pull request のレビューのコメント
  else if (gitHub.event === 'pull_request_review_comment' && (gitHub.action === 'created' || gitHub.action === 'edited'))  {
    message.title = `Review on #${gitHub.pullRequest.number} ${gitHub.pullRequest.title}`;
    message.url = gitHub.comment.html_url;
    message.body = gitHub.comment.body;
  } else {
    // どのイベントでもない場合は終了
    return {
      statusCode: 200,
      body: 'Process has been passed through.',
    }; 
  }

  // メッセージが空の場合は終了
  if (!message.body) {
    return {
      statusCode: 200,
      body: 'Process has been passed through.',
    }; 
  }

  const slackChannels = []; // 通知先 Slack チャンネル

  message.body = message.body.replace(/@[A-Za-z0-9-/]+/g, (match) => {
    // リポジトリが一致するものを検索
    const settingRepo = settings
      .find((element) => {
        return element.github_repository === gitHub.repository && element.github_id === match;
      });
    // リポジトリが*設定のものを検索
    const settingAll = settings
      .find((element) => {
        return element.github_repository === '*' && element.github_id === match;
      });

    let setting;
    if (settingRepo) {
      setting = settingRepo; // リポジトリが一致するものが優先
    } else if (settingAll) {
      setting = settingAll;
    } else {
      return match; // 置換せずそのまま返す
    }

    if (setting.slack_channel !== '-' && isValidString(setting.slack_channel)) {
      slackChannels.push(setting.slack_channel); // 通知先 Slack チャンネルのリストへ追加
    }

    if (setting.slack_id === '-' || !isValidString(setting.slack_id)) {
      return match;
    }

    // Slack の ID へ置換
    return setting.slack_id;
  });

  // 通知先が0件の場合は終了
  if (!slackChannels.length) {
    return {
      statusCode: 200,
      body: 'Process has been passed through.',
    };
  }

  // 通知先の重複削除
  const distinctSlackChannels = slackChannels
    .filter((element, index, array) => array.indexOf(element) === index);
  
  // Slack へ投稿
  const results = await Promise.all(distinctSlackChannels.map(channel => {
    return post(channel, message, gitHub);
  }));

  // 結果にエラーが含まれる場合
  for (let r of results) {
    if (r instanceof Error) {
      return {
        statusCode: 500,
        body: 'Some were not posted.',
      };
    }
  }

  return {
    statusCode: 200,
    body: `All posts to slack.`,
  };
};

function post(channel, message, gitHub) {
  return new Promise((resolve, reject) => {
    const data = {
      username: "GitHub",
      icon_url: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
      channel: channel,
      attachments: [
        {
          fallback: message.body,
          color: "#ffb432",
          author_name: gitHub.senderName,
          author_link: gitHub.senderUrl,
          author_icon: gitHub.senderIconUrl,
          title: message.title,
          title_link: message.url,
          text: message.body,
          footer: gitHub.repository,
          footer_icon: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
          ts: Math.floor(new Date().getTime() / 1000),
        }
      ],
    };
    const options = {
      host: 'slack.com',
      port: '443',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_TOKEN,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, res => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const result = JSON.parse(chunk);
        if (result.ok) {
          resolve(chunk);
        } else {
          resolve(new Error());
        }
      });
    });
    req.on('error', e => {
      // Lambda を正常に終了する為には全ての並列リクエストが完了するのを
      // 待ってからエラー処理する必要があるのでここでは reject しない
      resolve(new Error());
    });
    req.write(JSON.stringify(data));
    req.end();
  });
}

function isValidString(arg) {
  return typeof arg === 'string' && arg !== '';
}

