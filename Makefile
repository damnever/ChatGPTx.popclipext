build:
	rm -f ./main.js ChatGPTx.popclipextz
	tsc main.ts || exit 0
	pushd .. && zip -r ChatGPTx.popclipextz ChatGPTx.popclipext && mv ChatGPTx.popclipextz ChatGPTx.popclipext && popd
