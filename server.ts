import express from 'express';
import { Telegraf, Scenes, session } from 'telegraf';
import fs from 'fs';

const app = express();
const PORT = 3000;

// In-memory storage (в рабочей версии лучше использовать базу данных, но для старта подойдет)
let applications: any[] = [];
const DB_FILE = 'applications.json';

// Загрузка заявок
if (fs.existsSync(DB_FILE)) {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf-8');
    applications = JSON.parse(data);
  } catch (e) {
    console.error('Error reading DB:', e);
  }
}

// Сохранение заявок
const saveApplications = (apps: any[]) => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(apps, null, 2));
  } catch (e) {
    console.error('Error writing DB:', e);
  }
};

const token = process.env.TELEGRAM_BOT_TOKEN;
let bot: Telegraf<any> | null = null;

if (token) {
  bot = new Telegraf(token);
  
  const applicationWizard = new Scenes.WizardScene(
    'application_wizard',
    (ctx) => {
      ctx.reply('Отлично! Ответьте на 3 вопроса.\n\n1. Пришлите ваш ник и ссылку на профиль в Senkuro.');
      ctx.wizard.state.application = {};
      return ctx.wizard.next();
    },
    (ctx) => {
      if (ctx.message && 'text' in ctx.message) {
        ctx.wizard.state.application.profile = ctx.message.text;
        ctx.reply('2. Как часто вы играете (сколько часов в день/неделю)?');
        return ctx.wizard.next();
      }
      return ctx.reply('Пожалуйста, отправьте текстовое сообщение.');
    },
    (ctx) => {
      if (ctx.message && 'text' in ctx.message) {
        ctx.wizard.state.application.playtime = ctx.message.text;
        ctx.reply('3. Почему вы хотите вступить именно в Silentium?');
        return ctx.wizard.next();
      }
      return ctx.reply('Пожалуйста, отправьте текстовое сообщение.');
    },
    async (ctx) => {
      if (ctx.message && 'text' in ctx.message) {
        ctx.wizard.state.application.reason = ctx.message.text;
        
        const newApp = {
          id: Math.random().toString(36).substring(2, 9),
          telegramId: ctx.from?.id,
          username: ctx.from?.username,
          profile: ctx.wizard.state.application.profile,
          playtime: ctx.wizard.state.application.playtime,
          reason: ctx.wizard.state.application.reason,
          status: 'pending',
          timestamp: new Date().toISOString()
        };
        
        applications.push(newApp);
        saveApplications(applications);
        
        await ctx.reply('✅ Ваша заявка отправлена! Ожидайте ответа от администрации.');
        
        const adminGroupId = process.env.ADMIN_GROUP_ID;
        if (adminGroupId) {
          try {
            await ctx.telegram.sendMessage(adminGroupId, 
              `🔔 **Новая заявка в гильдию!**\n\n` +
              `👤 **Пользователь:** @${newApp.username || 'Без юзернейма'} (ID: ${newApp.telegramId})\n` +
              `🔗 **Профиль:** ${newApp.profile}\n` +
              `⏱ **Онлайн:** ${newApp.playtime}\n` +
              `📝 **Причина:** ${newApp.reason}\n\n` +
              `ID заявки: ${newApp.id}`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '✅ Принять', callback_data: `accept_${newApp.id}` },
                      { text: '❌ Отклонить', callback_data: `rej_prompt_${newApp.id}` }
                    ],
                    [
                      { text: '✉️ Написать сообщение', callback_data: `reply_${newApp.id}` }
                    ]
                  ]
                }
              }
            );
          } catch (e) {
            console.error('Failed to send admin notification', e);
          }
        }
        
        return ctx.scene.leave();
      }
      return ctx.reply('Пожалуйста, отправьте текстовое сообщение.');
    }
  );

  const stage = new Scenes.Stage([applicationWizard]);
  bot.use(session());
  bot.use(stage.middleware());

  bot.command('start', (ctx) => {
    ctx.reply('Здравствуйте! Я бот, который поможет вам подать заявку на вступление в гильдию Silentium на сайте Senkuro.\nНажмите на кнопку ниже, чтобы начать заполнять анкету.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📝 Начать заполнение', callback_data: 'start_application' }]
        ]
      }
    });
  });

  bot.action('start_application', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('application_wizard');
  });

  bot.command('getgroupid', (ctx) => {
    ctx.reply(`ID этого чата: ${ctx.chat.id}`);
  });

  bot.action(/accept_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const application = applications.find(a => a.id === id);
    
    if (application) {
      if (application.status !== 'pending') return ctx.answerCbQuery('Заявка уже обработана.');
      application.status = 'accepted';
      saveApplications(applications);
    }
    
    try {
      const telegramId = application ? application.telegramId : parseInt(id, 10);
      if (telegramId && !isNaN(telegramId)) {
        await bot.telegram.sendMessage(telegramId, '🎉 Ваша заявка в гильдию Silentium была одобрена! Добро пожаловать, вот ссылка на наш чат: https://t.me/+VzkHhfqRc3BkOTFi');
      }
      const msgText = ctx.callbackQuery.message?.text || '';
      await ctx.editMessageText(msgText + '\n\n✅ **СТАТУС: ПРИНЯТА**');
      await ctx.answerCbQuery('Заявка принята!');
    } catch (e) {
      console.error(e);
      await ctx.answerCbQuery('Ошибка при отправке сообщения пользователю.');
    }
  });

  bot.action(/rej_prompt_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [{ text: '📉 Мало времени на игру', callback_data: `rej_onl_${id}` }],
        [{ text: '⚔️ Слабый профиль', callback_data: `rej_prof_${id}` }],
        [{ text: '✍️ Своя причина (Ввести вручную)', callback_data: `rej_man_${id}` }],
        [{ text: '🔙 Назад', callback_data: `rej_c_${id}` }]
      ]
    }).catch(console.error);
  });

  bot.action(/rej_c_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [
          { text: '✅ Принять', callback_data: `accept_${id}` },
          { text: '❌ Отклонить', callback_data: `rej_prompt_${id}` }
        ],
        [
          { text: '✉️ Написать сообщение', callback_data: `reply_${id}` }
        ]
      ]
    }).catch(console.error);
  });

  const processReject = async (ctx: any, id: string, reason: string) => {
    const application = applications.find(a => a.id === id);
    
    if (application) {
      if (application.status !== 'pending') return ctx.answerCbQuery('Заявка уже обработана.');
      application.status = 'rejected';
      saveApplications(applications);
    }
    
    try {
      const telegramId = application ? application.telegramId : parseInt(id, 10);
      if (telegramId && !isNaN(telegramId)) {
        await bot.telegram.sendMessage(telegramId, `😔 К сожалению, ваша заявка в гильдию Silentium была отклонена.\n\n📝 Причина: ${reason}`);
      }
      const msgText = ctx.callbackQuery.message?.text || '';
      await ctx.editMessageText(msgText + `\n\n❌ **СТАТУС: ОТКЛОНЕНА**\nПричина: ${reason}`);
      await ctx.answerCbQuery('Заявка отклонена!');
    } catch (e) {
      console.error(e);
      await ctx.answerCbQuery('Ошибка при отправке сообщения пользователю.');
    }
  };

  bot.action(/rej_onl_(.+)/, async (ctx) => {
    await processReject(ctx, ctx.match[1], "Нам нужны более активные игроки (недостаточный онлайн).");
  });

  bot.action(/rej_prof_(.+)/, async (ctx) => {
    await processReject(ctx, ctx.match[1], "Ваш профиль пока не соответствует минимальным требованиям гильдии.");
  });

  bot.action(/rej_man_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Ответьте (Reply) на это сообщение текстом, который начнется со слова "Отказ:" (например: "Отказ: мест нет").', { show_alert: true });
  });

  bot.action(/reply_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCbQuery('Ответьте (Reply) на это сообщение с текстом, который хотите отправить кандидату.', { show_alert: true });
  });

  bot.on('message', async (ctx) => {
    if (ctx.message && 'reply_to_message' in ctx.message && ctx.message.reply_to_message) {
      const repliedMessage = ctx.message.reply_to_message;
      if ('text' in repliedMessage && repliedMessage.text?.includes('ID заявки:')) {
        const match = repliedMessage.text.match(/ID заявки: (\w+)/);
        if (match) {
          const id = match[1];
          const app = applications.find(a => a.id === id);
          const targetTelegramId = app ? app.telegramId : parseInt(id, 10);
          
          if (targetTelegramId && !isNaN(targetTelegramId)) {
            // Ручное отклонение
            if ('text' in ctx.message && ctx.message.text.toLowerCase().startsWith('отказ:')) {
              const reason = ctx.message.text.substring(6).trim();
              
              if (app && app.status !== 'pending') {
                 await ctx.reply('⚠️ Заявка уже была обработана ранее.', { reply_to_message_id: ctx.message.message_id });
                 return;
              }
              if (app) {
                app.status = 'rejected';
                saveApplications(applications);
              }

              try {
                await bot.telegram.sendMessage(targetTelegramId, `😔 К сожалению, ваша заявка в гильдию Silentium была отклонена.\n\n📝 Причина: ${reason}`);
                try {
                  await bot.telegram.editMessageText(ctx.chat.id, ctx.message.reply_to_message.message_id, undefined, repliedMessage.text + `\n\n❌ **СТАТУС: ОТКЛОНЕНА**\nПричина: ${reason}`);
                } catch(e) {} // Игнорируем если не получилось обновить старое сообщение
                await ctx.reply('✅ Кандидат отклонен (указана ручная причина).', { reply_to_message_id: ctx.message.message_id });
              } catch (err) {
                await ctx.reply('❌ Ошибка отправки пользователю.', { reply_to_message_id: ctx.message.message_id });
              }
              return;
            }

            // Обычное сообщение
            if ('text' in ctx.message) {
                try {
                await bot.telegram.sendMessage(targetTelegramId, `📩 **Сообщение от администрации:**\n\n${ctx.message.text}`);
                await ctx.reply('✅ Сообщение отправлено.', { reply_to_message_id: ctx.message.message_id });
                } catch (err) {
                await ctx.reply('❌ Ошибка: возможно пользователь заблокировал бота.', { reply_to_message_id: ctx.message.message_id });
                }
            }
          }
        }
      }
    }
  });

  // Start bot (Long Polling)
  if (bot) {
    bot.launch().catch(console.error);
  }

  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

app.use(express.json());

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', botActive: !!bot });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});