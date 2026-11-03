import {
  ConnectionClosedError,
  DuplicateLoginDeclinedError,
  LoginFailedError,
  TooFrequentError,
  UnexpectedScreenError,
} from '../errors';
import { Keys } from '../keys';
import {
  isLoginAnyKeyPrompt,
  isDeleteAttemptsPrompt,
  isDuplicateLoginPrompt,
  isFrequentLoginNotice,
  isLoginPrompt,
  isMainMenu,
  isNoSuchAccount,
  isPasswordPrompt,
  isTryLater,
  isWrongPassword,
} from '../screens/prompts';
import type { Credentials, Session } from './session';

type PostLoginScreen =
  | 'menu'
  | 'wrongPassword'
  | 'noAccount'
  | 'tryLater'
  | 'deleteAttempts'
  | 'duplicate'
  | 'frequentNotice'
  | 'anyKey';

const STEP_TIMEOUT_MS = 20_000;
// After the duplicate-login answer PTT takes a few seconds before it acts (seen: still on the prompt after
// 1.2 s, connection closed by about 5 s when the answer was "keep").
const DUPLICATE_ANSWER_TIMEOUT_MS = 15_000;
const MAX_STEPS = 10;

/**
 * Walks the login screens. The password is typed exactly once and never appears in errors, logs or snapshots
 * (the BBS does not echo it). Runs inside the session queue.
 */
export async function runLogin(session: Session, credentials: Credentials): Promise<void> {
  await session.waitFor(isLoginPrompt, 'login prompt', 10_000);

  // A username ending in a comma switches the session from Big5 to UTF-8. Switch the decoder first so the
  // reply, however fast, is decoded correctly.
  session.terminal.setEncoding('utf-8');
  session.send(`${credentials.username},`, Keys.ENTER);

  const afterUsername = await session.waitFor(
    (l) => (isPasswordPrompt(l) ? 'password' : isNoSuchAccount(l) ? 'noAccount' : false),
    'password prompt',
    10_000
  );
  if (afterUsername === 'noAccount') {
    throw new LoginFailedError('noAccount');
  }

  session.send(credentials.password, Keys.ENTER);

  for (let step = 0; step < MAX_STEPS; step++) {
    const screen = await session.waitFor<PostLoginScreen>(
      (l) =>
        isMainMenu(l)
          ? 'menu'
          : isWrongPassword(l)
            ? 'wrongPassword'
            : isNoSuchAccount(l)
              ? 'noAccount'
              : isTryLater(l)
                ? 'tryLater'
                : isDeleteAttemptsPrompt(l)
                  ? 'deleteAttempts'
                  : isDuplicateLoginPrompt(l)
                    ? 'duplicate'
                    : isFrequentLoginNotice(l)
                      ? 'frequentNotice'
                      : isLoginAnyKeyPrompt(l)
                        ? 'anyKey'
                        : false,
      'a post-login screen',
      STEP_TIMEOUT_MS
    );

    switch (screen) {
      case 'menu':
        return;
      case 'wrongPassword':
        throw new LoginFailedError('wrongPassword');
      case 'noAccount':
        throw new LoginFailedError('noAccount');
      case 'tryLater':
        throw new TooFrequentError();
      case 'deleteAttempts':
        // Answer "no": the record of failed logins is the account's audit trail, and declining still lets the
        // login continue. The answer field starts empty and is submitted with Enter (verified for the
        // duplicate-login prompt, which looks the same; this prompt itself has not been seen yet).
        await session.answer(
          `n${Keys.ENTER}`,
          isDeleteAttemptsPrompt,
          'attempt log prompt to close'
        );
        break;
      case 'duplicate': {
        const kick = await shouldKickOtherSession(session);
        try {
          await session.answer(
            `${kick ? 'y' : 'n'}${Keys.ENTER}`,
            isDuplicateLoginPrompt,
            'duplicate login prompt to close',
            DUPLICATE_ANSWER_TIMEOUT_MS
          );
        } catch (error) {
          // Verified on the live server: answering "n" makes PTT close this new connection.
          throw !kick && error instanceof ConnectionClosedError
            ? new DuplicateLoginDeclinedError()
            : error;
        }
        break;
      }
      case 'frequentNotice':
        await session.answer(Keys.ENTER, isFrequentLoginNotice, 'frequent-login notice to close');
        break;
      case 'anyKey':
        await session.sendAndWaitChange(Keys.SPACE, 'the next screen');
        break;
    }
  }
  throw new UnexpectedScreenError('Did not reach the main menu after login', session.snapshot());
}

async function shouldKickOtherSession(session: Session): Promise<boolean> {
  const { duplicateSession, onDuplicateSession } = session.settings;
  if (duplicateSession === 'kick') {
    return true;
  }
  if (duplicateSession === 'ask' && onDuplicateSession) {
    try {
      return await onDuplicateSession();
    } catch {
      return false; // the question could not be asked, so the answer is no
    }
  }
  return false; // keep, or ask with nobody to ask: never log someone out by default
}
