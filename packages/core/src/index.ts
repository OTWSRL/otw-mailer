export { domainOf, formatAddress, isEmail, parseAddress, parseAddresses } from './address.ts'
export { checkConfig } from './config.ts'
export { MailerError, type MailerErrorCode } from './errors.ts'
export {
  createMailer,
  DeliveryError,
  type Mailer,
  type MailerOptions,
  type SendOptions,
} from './mailer.ts'
export { prepare, recipients, type Defaults } from './message.ts'
export { formatDate, toMime } from './mime.ts'
export {
  isMailerId,
  mailerInfo,
  MAILERS,
  type MailerField,
  type MailerId,
  type MailerInfo,
} from './registry.ts'
export { CONDITION_FIELDS, CONDITION_OPERATORS, matches, routeFor } from './routing.ts'
export type {
  Address,
  AddressInput,
  AddressList,
  Attachment,
  Attempt,
  Condition,
  ConditionField,
  ConditionOperator,
  Connection,
  CreateTransport,
  Delivery,
  Email,
  EmailAttachment,
  Header,
  Message,
  OAuthTokens,
  Receipt,
  Route,
  TokenStore,
  Transport,
  TransportContext,
} from './types.ts'
