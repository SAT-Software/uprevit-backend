import google from 'eslint-config-google';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

const { 'valid-jsdoc': _validJsdoc, 'require-jsdoc': _requireJsdoc, ...googleRules } = google.rules;

export default [
	{ ignores: ['node_modules/**', '.aws-sam/**', 'coverage/**', 'assets/**'] },
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			ecmaVersion: 'latest',
			sourceType: 'module',
		},
		linterOptions: { reportUnusedDisableDirectives: 'off' },
		plugins: { '@typescript-eslint': tseslint.plugin },
		rules: googleRules,
	},
	prettier,
	{
		files: ['**/*.ts'],
		rules: {
			indent: ['error', 'tab'],
			'no-tabs': 'off',
			'new-cap': 'off',
			'max-len': 'off',
			'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
		},
	},
];
