export function validateInternationalPhone(phone: string): boolean {
  const cleaned = phone.replace(/\s/g, '');
  const intlPattern = /^\+[1-9]\d{6,14}$/;
  return intlPattern.test(cleaned);
}

export function formatPhoneNumber(countryCode: string, localNumber: string): string {
  const cleaned = localNumber.replace(/\D/g, '');
  return `${countryCode}${cleaned}`;
}

export function extractVariables(content: string): string[] {
  const regex = /\{(\w+)\}/g;
  const vars: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (!vars.includes(match[1])) {
      vars.push(match[1]);
    }
  }
  return vars;
}

export function renderTemplate(content: string, variables: Record<string, string>): string {
  return content.replace(/\{(\w+)\}/g, (_, key) => variables[key] ?? `{${key}}`);
}

export function getSaudacao(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}
